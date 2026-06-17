// ALL DMMF access is isolated here (CLAUDE.md). Everything downstream consumes the clean
// internal shapes (HypertableConfig / CaggConfig) and never touches `options.dmmf`. A Prisma
// internal-API change should only require edits in this file.
import type { DMMF } from "@prisma/generator-helper";
import type {
  AggregateSpec,
  CaggConfig,
  CaggGroupBy,
  CompressionConfig,
  CompressionOrderBy,
  HypertableConfig,
  RefreshPolicy,
  RelationConfig,
  RetentionConfig,
} from "../core/types.js";
import type { Interval } from "../core/interval.js";
import { assertInterval } from "../core/interval.js";
import { parseOrderByTerm } from "../core/compression.js";
import {
  findAnnotation,
  optionalBoolean,
  optionalObject,
  optionalString,
  parseAnnotations,
  requireString,
} from "./annotations.js";

export interface TimescaleSchema {
  hypertables: HypertableConfig[];
  continuousAggregates: CaggConfig[];
  /** Relations of every non-hypertable model, keyed by Prisma model name — lets timeBucket where
   * resolve relation filters nested through other relations to any depth. */
  relationsByModel: Record<string, RelationConfig[]>;
}

// Field types acceptable as a hypertable / continuous-aggregate partitioning column. DateTime
// only: integer time columns aren't supported yet — every builder emits interval-based SQL
// (`by_range(col, INTERVAL …)`, `time_bucket($1, col)`), so accepting Int/BigInt here would pass
// generation and then fail at `migrate`. Reject them up front with a clear message instead.
const TIME_TYPES = new Set(["DateTime"]);
const AGG_FNS = new Set<AggregateSpec["fn"]>(["avg", "sum", "min", "max", "count"]);

/** Extract and validate all TimescaleDB configs from a Prisma DMMF document. */
export function extractTimescaleSchema(dmmf: DMMF.Document): TimescaleSchema {
  const models = dmmf.datamodel.models;
  const byName = new Map(models.map((m) => [m.name, m]));

  const hypertables: HypertableConfig[] = [];
  const continuousAggregates: CaggConfig[] = [];

  for (const model of models) {
    const annotations = parseAnnotations(model.documentation);
    if (findAnnotation(annotations, "hypertable")) {
      hypertables.push(buildHypertable(model, annotations, byName));
    } else {
      // Retention / compression attach to a hypertable's chunks; meaningless on a plain model.
      for (const dependent of ["retention", "compression"] as const) {
        if (findAnnotation(annotations, dependent)) {
          throw new Error(
            `@timescale.${dependent} on model "${model.name}": only valid together with @timescale.hypertable.`,
          );
        }
      }
    }
    if (findAnnotation(annotations, "continuousAggregate")) {
      continuousAggregates.push(buildCagg(model, annotations, byName));
    }
  }

  // A continuous aggregate's source must be a hypertable OR another continuous aggregate (a
  // hierarchical / "cagg-on-cagg" rollup); anything else fails the emitted CREATE MATERIALIZED VIEW.
  const hypertableNames = new Set(hypertables.map((h) => h.table));
  const caggNames = new Set(continuousAggregates.map((c) => c.name));
  for (const cagg of continuousAggregates) {
    if (cagg.source === cagg.name) {
      throw new Error(`@timescale.continuousAggregate on view "${cagg.name}": a continuous aggregate cannot be its own source.`);
    }
    if (!hypertableNames.has(cagg.source) && !caggNames.has(cagg.source)) {
      throw new Error(
        `@timescale.continuousAggregate on view "${cagg.name}": source "${cagg.source}" must be a @timescale.hypertable or another @timescale.continuousAggregate.`,
      );
    }
  }

  // Relations of every NON-hypertable model (keyed by Prisma model name), so timeBucket where can
  // resolve relation filters nested THROUGH a relation. Hypertables' own relations stay on their
  // config entry (the runtime merges both). Cycle-safe: lookups are by name and recursion is
  // bounded by the query's actual nesting depth, so a Reading<->Device cycle never loops here.
  const hypertableModelNames = new Set(hypertables.map((h) => h.model ?? h.table));
  const relationsByModel: Record<string, RelationConfig[]> = {};
  for (const model of models) {
    if (hypertableModelNames.has(model.name)) continue;
    const rels = buildRelations(model, byName);
    if (rels.length > 0) relationsByModel[model.name] = rels;
  }

  return { hypertables, continuousAggregates, relationsByModel };
}

/** Build a HypertableConfig from a `@timescale.hypertable` model — validates the time column and
 * resolves @map/@@schema, retention, and relations. */
function buildHypertable(
  model: DMMF.Model,
  annotations: ReturnType<typeof parseAnnotations>,
  byName: Map<string, DMMF.Model>,
): HypertableConfig {
  const ctx = `@timescale.hypertable on model "${model.name}"`;
  const ann = findAnnotation(annotations, "hypertable")!;
  const column = requireString(ann.args, "column", ctx);
  const chunkInterval = optionalString(ann.args, "chunkInterval", ctx);

  const field = findScalarField(model, column);
  if (!field) {
    throw new Error(`${ctx}: column "${column}" is not a scalar field on the model.`);
  }
  if (!TIME_TYPES.has(field.type)) {
    throw new Error(
      `${ctx}: column "${column}" has type ${field.type}; the partitioning column must be a DateTime field (integer time columns are not supported yet).`,
    );
  }
  if (chunkInterval !== undefined) assertInterval(chunkInterval);

  const columns = columnMap(model);
  const table = dbTable(model);
  const retention = buildRetention(annotations, model.name);
  const compression = buildCompression(annotations, model);
  const spacePartition = buildSpacePartition(ann, model, ctx);
  const chunkSkipping = buildChunkSkipping(ann, model, ctx, dbCol(field), compression, spacePartition?.column);
  const relations = buildRelations(model, byName);

  return {
    ...(model.name !== table ? { model: model.name } : {}),
    table,
    ...(model.schema ? { schema: model.schema } : {}),
    column: dbCol(field),
    ...(chunkInterval !== undefined ? { chunkInterval: chunkInterval as Interval } : {}),
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(retention ? { retention } : {}),
    ...(compression ? { compression } : {}),
    ...(spacePartition ? { spacePartition } : {}),
    ...(chunkSkipping ? { chunkSkipping } : {}),
    ...(relations.length > 0 ? { relations } : {}),
  };
}

/**
 * Extract the model's relation fields into RelationConfigs for runtime EXISTS-based filtering.
 * Resolves join keys for both the owning side (this model holds the FK: relationFromFields ->
 * relationToFields) and the inverse side (the FK lives on the related model — look up its owning
 * field by relationName). All field names are resolved to DB column names (@map).
 */
function buildRelations(model: DMMF.Model, byName: Map<string, DMMF.Model>): RelationConfig[] {
  const relations: RelationConfig[] = [];
  for (const f of model.fields) {
    if (f.kind !== "object") continue;
    const related = byName.get(f.type);
    if (!related) continue;

    let on: { related: string; outer: string }[];
    let fk: string[] | undefined;

    if (f.relationFromFields && f.relationFromFields.length > 0) {
      // Owning side: the FK is on THIS model (relationFromFields), referencing relationToFields.
      const toFields = f.relationToFields ?? [];
      on = f.relationFromFields.map((fromField, i) => ({
        related: resolveCol(related, toFields[i] ?? ""),
        outer: resolveCol(model, fromField),
      }));
      fk = f.relationFromFields.map((fromField) => resolveCol(model, fromField));
    } else {
      // Inverse side: the FK is on the RELATED model — find its owning field by relationName.
      const owning = related.fields.find(
        (g) => g.kind === "object" && g.relationName === f.relationName && (g.relationFromFields?.length ?? 0) > 0,
      );
      if (!owning?.relationFromFields || !owning.relationToFields) continue;
      const toFields = owning.relationToFields;
      on = owning.relationFromFields.map((fromField, i) => ({
        related: resolveCol(related, fromField),
        outer: resolveCol(model, toFields[i] ?? ""),
      }));
    }

    const columns = columnMap(related);
    relations.push({
      field: f.name,
      targetModel: related.name,
      table: dbTable(related),
      ...(related.schema ? { schema: related.schema } : {}),
      list: f.isList,
      on,
      ...(Object.keys(columns).length > 0 ? { columns } : {}),
      ...(fk ? { fk } : {}),
    });
  }
  return relations;
}

/** Resolve a field name on a model to its DB column name (the @map value, or the field name). */
function resolveCol(model: DMMF.Model, fieldName: string): string {
  return model.fields.find((f) => f.name === fieldName)?.dbName ?? fieldName;
}

/** Parse the optional `@timescale.retention(dropAfter)` annotation on a hypertable model. */
function buildRetention(
  annotations: ReturnType<typeof parseAnnotations>,
  modelName: string,
): RetentionConfig | undefined {
  const ann = findAnnotation(annotations, "retention");
  if (!ann) return undefined;
  const ctx = `@timescale.retention on model "${modelName}"`;
  const dropAfter = requireString(ann.args, "dropAfter", ctx);
  assertInterval(dropAfter);
  return { dropAfter: dropAfter as Interval };
}

/**
 * Parse the optional `@timescale.compression(after, segmentBy?, orderBy?)` annotation on a
 * hypertable model. Validates the `after` interval and resolves the (comma-separated) segmentBy /
 * orderBy Prisma field names to DB columns (@map), preserving any ASC/DESC/NULLS in orderBy.
 */
function buildCompression(
  annotations: ReturnType<typeof parseAnnotations>,
  model: DMMF.Model,
): CompressionConfig | undefined {
  const ann = findAnnotation(annotations, "compression");
  if (!ann) return undefined;
  const ctx = `@timescale.compression on model "${model.name}"`;
  const after = requireString(ann.args, "after", ctx);
  assertInterval(after);

  const config: { after: Interval; segmentBy?: string[]; orderBy?: CompressionOrderBy[] } = {
    after: after as Interval,
  };

  const segmentByRaw = optionalString(ann.args, "segmentBy", ctx);
  if (segmentByRaw !== undefined) {
    const segmentBy = splitList(segmentByRaw).map((name) => {
      const field = findScalarField(model, name);
      if (!field) throw new Error(`${ctx}: segmentBy column "${name}" is not a scalar field on the model.`);
      return dbCol(field);
    });
    if (segmentBy.length > 0) config.segmentBy = segmentBy;
  }

  const orderByRaw = optionalString(ann.args, "orderBy", ctx);
  if (orderByRaw !== undefined) {
    const orderBy = splitList(orderByRaw).map((term) => {
      const parsed = parseOrderByTerm(term);
      const field = findScalarField(model, parsed.column);
      if (!field) throw new Error(`${ctx}: orderBy column "${parsed.column}" is not a scalar field on the model.`);
      return { ...parsed, column: dbCol(field) };
    });
    if (orderBy.length > 0) config.orderBy = orderBy;
  }

  return config;
}

/** Split a comma-separated annotation list (segmentBy / orderBy) into trimmed, non-empty entries. */
function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse the optional hash space dimension off the hypertable annotation: `partitionColumn` (a scalar
 * field, resolved to its @map DB column) + `partitions` (a positive integer). Both are required
 * together; omitted means a time-only hypertable.
 */
function buildSpacePartition(
  ann: ReturnType<typeof parseAnnotations>[number],
  model: DMMF.Model,
  ctx: string,
): { column: string; partitions: number } | undefined {
  const partitionColumn = optionalString(ann.args, "partitionColumn", ctx);
  const partitionsRaw = optionalString(ann.args, "partitions", ctx);
  if (partitionColumn === undefined && partitionsRaw === undefined) return undefined;
  if (partitionColumn === undefined || partitionsRaw === undefined) {
    throw new Error(`${ctx}: partitionColumn and partitions must be set together (hash space dimension).`);
  }
  const field = findScalarField(model, partitionColumn);
  if (!field) {
    throw new Error(`${ctx}: partitionColumn "${partitionColumn}" is not a scalar field on the model.`);
  }
  // TimescaleDB requires every PK / unique index to include all partitioning columns, so a
  // partitionColumn outside them fails at `migrate` ("cannot create a unique index without the
  // column …"). Reject it at generation time with a clear error instead. Field names below are
  // Prisma names, matching `partitionColumn`.
  const keyFieldSets: (readonly string[])[] = [
    ...(model.primaryKey?.fields ? [model.primaryKey.fields] : []),
    ...model.fields.filter((f) => f.isId).map((f) => [f.name]), // single-field @id
    ...model.uniqueIndexes.map((u) => u.fields),
    ...model.fields.filter((f) => f.isUnique).map((f) => [f.name]), // single-field @unique
  ];
  const missingFrom = keyFieldSets.find((fields) => !fields.includes(partitionColumn));
  if (missingFrom) {
    throw new Error(
      `${ctx}: partitionColumn "${partitionColumn}" must be included in every primary key / unique constraint (TimescaleDB requires all partitioning columns in unique indexes); it is missing from [${missingFrom.join(", ")}].`,
    );
  }
  const partitions = Number(partitionsRaw);
  if (!Number.isInteger(partitions) || partitions < 1) {
    throw new Error(`${ctx}: partitions must be a positive integer (got ${JSON.stringify(partitionsRaw)}).`);
  }
  return { column: dbCol(field), partitions };
}

/**
 * Parse the optional `chunkSkipping` arg (a comma-separated list of Prisma field names) off the
 * hypertable annotation into DB column names. Each must be a scalar field and is rejected if it is a
 * partitioning column — the time dimension or the hash space-partition column (both already prune
 * chunks) — or a compression `segmentBy` column (enabling chunk skipping there returns wrong query
 * results — verified empirically). Comparisons are on DB names (`timeColumnDb`/`partitionColumnDb`
 * are already resolved), so an `@map` alias is caught too.
 */
function buildChunkSkipping(
  ann: ReturnType<typeof parseAnnotations>[number],
  model: DMMF.Model,
  ctx: string,
  timeColumnDb: string,
  compression: CompressionConfig | undefined,
  partitionColumnDb: string | undefined,
): string[] | undefined {
  const raw = optionalString(ann.args, "chunkSkipping", ctx);
  if (raw === undefined) return undefined;
  const segmentBy = new Set(compression?.segmentBy ?? []); // DB names
  const columns = splitList(raw).map((name) => {
    const field = findScalarField(model, name);
    if (!field) {
      throw new Error(`${ctx}: chunkSkipping column "${name}" is not a scalar field on the model.`);
    }
    const db = dbCol(field);
    if (db === timeColumnDb) {
      throw new Error(
        `${ctx}: chunkSkipping column "${name}" is the time/partitioning column; that dimension already prunes chunks.`,
      );
    }
    if (partitionColumnDb !== undefined && db === partitionColumnDb) {
      throw new Error(
        `${ctx}: chunkSkipping column "${name}" is the hash space-partition column; that dimension already prunes chunks — chunkSkipping must target a non-partitioning column.`,
      );
    }
    if (segmentBy.has(db)) {
      throw new Error(
        `${ctx}: chunkSkipping column "${name}" is also a compression segmentBy column; skipping on a segmentBy column returns wrong results — drop it from one of the two.`,
      );
    }
    return db;
  });
  return columns.length > 0 ? columns : undefined;
}

/** Build a CaggConfig from a `@timescale.continuousAggregate` view + its field annotations
 * (`@timescale.bucket` / `groupBy` / `aggregate`), validating columns against the source model. */
function buildCagg(
  view: DMMF.Model,
  annotations: ReturnType<typeof parseAnnotations>,
  byName: Map<string, DMMF.Model>,
): CaggConfig {
  const ctx = `@timescale.continuousAggregate on view "${view.name}"`;
  const ann = findAnnotation(annotations, "continuousAggregate")!;

  const source = requireString(ann.args, "source", ctx);
  const bucket = requireString(ann.args, "bucket", ctx);
  const timeColumn = requireString(ann.args, "timeColumn", ctx);
  assertInterval(bucket);

  const sourceModel = byName.get(source);
  if (!sourceModel) {
    throw new Error(`${ctx}: source "${source}" is not a known model.`);
  }
  const timeField = findScalarField(sourceModel, timeColumn);
  if (!timeField) {
    throw new Error(`${ctx}: timeColumn "${timeColumn}" does not exist on source "${source}".`);
  }
  if (!TIME_TYPES.has(timeField.type)) {
    throw new Error(
      `${ctx}: timeColumn "${timeColumn}" has type ${timeField.type}; it must be a DateTime field (integer time columns are not supported yet).`,
    );
  }

  // Field-level annotations on the view. All names below are resolved to DB names: the
  // view's output columns use the view fields' @map names; source refs use the source
  // fields' @map names.
  let bucketColumn: string | undefined; // view bucket field's DB name
  let sawBucket = false;
  const groupBy: CaggGroupBy[] = [];
  const aggregates: AggregateSpec[] = [];

  for (const field of view.fields) {
    const fieldAnns = parseAnnotations(field.documentation);
    const fctx = `@timescale field on "${view.name}.${field.name}"`;

    if (findAnnotation(fieldAnns, "bucket")) {
      if (sawBucket) {
        throw new Error(`${ctx}: more than one @timescale.bucket field (second on "${field.name}").`);
      }
      sawBucket = true;
      bucketColumn = dbCol(field);
    }
    if (findAnnotation(fieldAnns, "groupBy")) {
      const srcField = findScalarField(sourceModel, field.name);
      if (!srcField) {
        throw new Error(`${fctx}: groupBy column "${field.name}" does not exist on source "${source}".`);
      }
      groupBy.push({ source: dbCol(srcField), output: dbCol(field) });
    }
    const aggAnn = findAnnotation(fieldAnns, "aggregate");
    if (aggAnn) {
      const fn = requireString(aggAnn.args, "fn", fctx) as AggregateSpec["fn"];
      const column = requireString(aggAnn.args, "column", fctx);
      if (!AGG_FNS.has(fn)) {
        throw new Error(`${fctx}: unsupported aggregate function "${fn}" (expected ${[...AGG_FNS].join(", ")}).`);
      }
      const srcField = findScalarField(sourceModel, column);
      if (!srcField) {
        throw new Error(`${fctx}: aggregate column "${column}" does not exist on source "${source}".`);
      }
      aggregates.push({ name: dbCol(field), fn, column: dbCol(srcField) });
    }
  }

  if (bucketColumn === undefined) {
    throw new Error(`${ctx}: missing the @timescale.bucket field (exactly one is required).`);
  }
  if (aggregates.length === 0) {
    throw new Error(`${ctx}: at least one @timescale.aggregate field is required.`);
  }

  const refresh = buildRefresh(ann, ctx);
  const materializedOnly = optionalBoolean(ann.args, "materializedOnly", ctx);
  const viewName = dbTable(view);

  return {
    ...(view.name !== viewName ? { model: view.name } : {}),
    name: viewName,
    ...(view.schema ? { schema: view.schema } : {}),
    source: dbTable(sourceModel),
    ...(sourceModel.schema ? { sourceSchema: sourceModel.schema } : {}),
    bucket: bucket as Interval,
    timeColumn: dbCol(timeField),
    bucketColumn,
    groupBy,
    aggregates,
    ...(refresh ? { refresh } : {}),
    ...(materializedOnly !== undefined ? { materializedOnly } : {}),
  };
}

/** Parse the optional `refresh: { startOffset, endOffset, scheduleInterval }` policy off a cagg annotation. */
function buildRefresh(ann: ReturnType<typeof parseAnnotations>[number], ctx: string): RefreshPolicy | undefined {
  const obj = optionalObject(ann.args, "refresh", ctx);
  if (!obj) return undefined;
  const rctx = `${ctx} refresh`;
  const startOffset = requireString(obj, "startOffset", rctx);
  const endOffset = requireString(obj, "endOffset", rctx);
  const scheduleInterval = requireString(obj, "scheduleInterval", rctx);
  assertInterval(startOffset);
  assertInterval(endOffset);
  assertInterval(scheduleInterval);
  return {
    startOffset: startOffset as Interval,
    endOffset: endOffset as Interval,
    scheduleInterval: scheduleInterval as Interval,
  };
}

/** Find a scalar (non-relation) field by name on a model. */
function findScalarField(model: DMMF.Model, name: string): DMMF.Field | undefined {
  return model.fields.find((f) => f.name === name && f.kind === "scalar");
}

/** DB table name: the @@map value, or the model name. */
function dbTable(model: DMMF.Model): string {
  return model.dbName ?? model.name;
}

/** DB column name: the @map value, or the field name. */
function dbCol(field: DMMF.Field): string {
  return field.dbName ?? field.name;
}

/** Map of Prisma field name -> DB column name, for fields that were renamed via @map. */
function columnMap(model: DMMF.Model): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of model.fields) {
    if (f.kind === "scalar" && f.dbName) map[f.name] = f.dbName;
  }
  return map;
}
