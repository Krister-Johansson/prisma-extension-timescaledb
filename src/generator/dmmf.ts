// ALL DMMF access is isolated here (CLAUDE.md). Everything downstream consumes the clean
// internal shapes (HypertableConfig / CaggConfig) and never touches `options.dmmf`. A Prisma
// internal-API change should only require edits in this file.
import type { DMMF } from "@prisma/generator-helper";
import type { AggregateSpec, CaggConfig, HypertableConfig, RefreshPolicy } from "../core/types.js";
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
      hypertables.push(buildHypertable(model, annotations));
    }
    if (findAnnotation(annotations, "continuousAggregate")) {
      continuousAggregates.push(buildCagg(model, annotations, byName));
    }
  }

  return { hypertables, continuousAggregates };
}

function buildHypertable(model: DMMF.Model, annotations: ReturnType<typeof parseAnnotations>): HypertableConfig {
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

  return {
    table: model.name,
    column,
    ...(chunkInterval !== undefined ? { chunkInterval: chunkInterval as Interval } : {}),
  };
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
  if (!findScalarField(sourceModel, timeColumn)) {
    throw new Error(`${ctx}: timeColumn "${timeColumn}" does not exist on source "${source}".`);
  }

  // Field-level annotations on the view.
  let bucketColumn: string | undefined;
  const groupBy: string[] = [];
  const aggregates: AggregateSpec[] = [];

  for (const field of view.fields) {
    const fieldAnns = parseAnnotations(field.documentation);
    const fctx = `@timescale field on "${view.name}.${field.name}"`;

    if (findAnnotation(fieldAnns, "bucket")) {
      if (bucketColumn !== undefined) {
        throw new Error(`${ctx}: more than one @timescale.bucket field ("${bucketColumn}" and "${field.name}").`);
      }
      bucketColumn = field.name;
    }
    if (findAnnotation(fieldAnns, "groupBy")) {
      if (!findScalarField(sourceModel, field.name)) {
        throw new Error(`${fctx}: groupBy column "${field.name}" does not exist on source "${source}".`);
      }
      groupBy.push(field.name);
    }
    const aggAnn = findAnnotation(fieldAnns, "aggregate");
    if (aggAnn) {
      const fn = requireString(aggAnn.args, "fn", fctx) as AggregateSpec["fn"];
      const column = requireString(aggAnn.args, "column", fctx);
      if (!AGG_FNS.has(fn)) {
        throw new Error(`${fctx}: unsupported aggregate function "${fn}" (expected ${[...AGG_FNS].join(", ")}).`);
      }
      if (!findScalarField(sourceModel, column)) {
        throw new Error(`${fctx}: aggregate column "${column}" does not exist on source "${source}".`);
      }
      aggregates.push({ name: field.name, fn, column });
    }
  }

  if (bucketColumn === undefined) {
    throw new Error(`${ctx}: missing the @timescale.bucket field (exactly one is required).`);
  }
  if (aggregates.length === 0) {
    throw new Error(`${ctx}: at least one @timescale.aggregate field is required.`);
  }

  const refresh = buildRefresh(ann, ctx);

  return {
    name: view.name,
    source,
    bucket: bucket as Interval,
    timeColumn,
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
