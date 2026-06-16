// ALL DMMF access is isolated here (CLAUDE.md). Everything downstream consumes the clean
// internal shapes (HypertableConfig / CaggConfig) and never touches `options.dmmf`. A Prisma
// internal-API change should only require edits in this file.
import type { DMMF } from "@prisma/generator-helper";
import type {
  AggregateSpec,
  CaggConfig,
  CaggGroupBy,
  HypertableConfig,
  RefreshPolicy,
  RelationConfig,
  RetentionConfig,
} from "../core/types.js";
import type { Interval } from "../core/interval.js";
import { assertInterval } from "../core/interval.js";
import {
  findAnnotation,
  optionalObject,
  optionalString,
  parseAnnotations,
  requireString,
} from "./annotations.js";

export interface TimescaleSchema {
  hypertables: HypertableConfig[];
  continuousAggregates: CaggConfig[];
}

// Field types acceptable as a hypertable / time_bucket partitioning column.
const TIME_TYPES = new Set(["DateTime", "Int", "BigInt"]);
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
    } else if (findAnnotation(annotations, "retention")) {
      // Retention attaches to a hypertable's chunks; it is meaningless on a plain model.
      throw new Error(
        `@timescale.retention on model "${model.name}": only valid together with @timescale.hypertable.`,
      );
    }
    if (findAnnotation(annotations, "continuousAggregate")) {
      continuousAggregates.push(buildCagg(model, annotations, byName));
    }
  }

  // A continuous aggregate's source must itself be a hypertable, otherwise the emitted
  // `CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)` fails at deploy/reset.
  const hypertableNames = new Set(hypertables.map((h) => h.table));
  for (const cagg of continuousAggregates) {
    if (!hypertableNames.has(cagg.source)) {
      throw new Error(
        `@timescale.continuousAggregate on view "${cagg.name}": source "${cagg.source}" must also be annotated with @timescale.hypertable.`,
      );
    }
  }

  return { hypertables, continuousAggregates };
}

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
      `${ctx}: column "${column}" has type ${field.type}; the partitioning column must be a DateTime or integer field.`,
    );
  }
  if (chunkInterval !== undefined) assertInterval(chunkInterval);

  const columns = columnMap(model);
  const table = dbTable(model);
  const retention = buildRetention(annotations, model.name);
  const relations = buildRelations(model, byName);

  return {
    ...(model.name !== table ? { model: model.name } : {}),
    table,
    ...(model.schema ? { schema: model.schema } : {}),
    column: dbCol(field),
    ...(chunkInterval !== undefined ? { chunkInterval: chunkInterval as Interval } : {}),
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(retention ? { retention } : {}),
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
      `${ctx}: timeColumn "${timeColumn}" has type ${timeField.type}; it must be a DateTime or integer field.`,
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
  };
}

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
