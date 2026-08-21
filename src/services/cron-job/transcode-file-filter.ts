import type { TranscodeWorkspaceOperator } from "./transcode-workspace-filter";

export type TranscodeFileField =
  "spaceId" | "creatorId" | "createdAt" | "metadata.size" | "metadata.highest";

export interface TranscodeFileRule {
  id: string;
  field: TranscodeFileField;
  operator: TranscodeWorkspaceOperator;
  value: string | string[] | number;
}

export interface TranscodeFileSelection {
  mode: "all" | "rules";
  match: "all" | "any";
  joins: Array<"and" | "or">;
  rules: TranscodeFileRule[];
  sort: Array<{
    field: "createdAt" | "size";
    direction: "asc" | "desc";
  }>;
}

type MongoQuery = Record<string, unknown>;

const FIELDS = new Set<TranscodeFileField>([
  "spaceId",
  "creatorId",
  "createdAt",
  "metadata.size",
  "metadata.highest",
]);
const DATE_FIELDS = new Set<TranscodeFileField>(["createdAt"]);
const NUMBER_FIELDS = new Set<TranscodeFileField>([
  "metadata.size",
  "metadata.highest",
]);
const RANGE_OPERATORS = new Set<TranscodeWorkspaceOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
const LIST_OPERATORS = new Set<TranscodeWorkspaceOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
]);

export const DEFAULT_TRANSCODE_FILE_SELECTION: TranscodeFileSelection = {
  mode: "all",
  match: "all",
  joins: [],
  rules: [],
  sort: [],
};

const uniqueStrings = (values: unknown) =>
  Array.isArray(values)
    ? [
        ...new Set(
          values
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
    : [];

export function normalizeTranscodeFileSelection(
  value: unknown,
  legacySort?: unknown,
): TranscodeFileSelection {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rules =
    Array.isArray(source.rules) && source.rules.length <= 20
      ? source.rules.filter((rule): rule is TranscodeFileRule => {
          if (!rule || typeof rule !== "object") return false;
          const candidate = rule as Record<string, unknown>;
          return (
            typeof candidate.id === "string" &&
            FIELDS.has(candidate.field as TranscodeFileField) &&
            ["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn"].includes(
              String(candidate.operator),
            )
          );
        })
      : [];
  const rawSort = Array.isArray(source.sort) ? source.sort : legacySort;

  return {
    mode: rules.length > 0 ? "rules" : "all",
    match: source.match === "any" ? "any" : "all",
    joins: Array.from({ length: Math.max(0, rules.length - 1) }, (_, index) =>
      Array.isArray(source.joins) &&
      (source.joins[index] === "and" || source.joins[index] === "or")
        ? (source.joins[index] as "and" | "or")
        : source.match === "any"
          ? "or"
          : "and",
    ),
    rules,
    sort: Array.isArray(rawSort)
      ? rawSort
          .flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const candidate = entry as Record<string, unknown>;
            if (candidate.field !== "createdAt" && candidate.field !== "size")
              return [];
            if (candidate.direction !== "asc" && candidate.direction !== "desc")
              return [];
            return [
              {
                field: candidate.field as "createdAt" | "size",
                direction: candidate.direction as "asc" | "desc",
              },
            ];
          })
          .slice(0, 2)
      : [],
  };
}

function normalizeRuleValue(rule: TranscodeFileRule): unknown {
  if (DATE_FIELDS.has(rule.field)) {
    if (!RANGE_OPERATORS.has(rule.operator) || typeof rule.value !== "string") {
      throw new Error("Invalid date rule");
    }
    const date = new Date(rule.value);
    if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
    return date;
  }
  if (NUMBER_FIELDS.has(rule.field)) {
    if (
      !RANGE_OPERATORS.has(rule.operator) ||
      typeof rule.value !== "number" ||
      !Number.isFinite(rule.value)
    ) {
      throw new Error("Invalid number rule");
    }
    return rule.value;
  }
  if (!LIST_OPERATORS.has(rule.operator)) throw new Error("Invalid operator");
  if (rule.operator === "in" || rule.operator === "notIn") {
    const values = uniqueStrings(rule.value);
    if (values.length === 0) throw new Error("Invalid list rule");
    return values;
  }
  if (typeof rule.value !== "string" || rule.value.trim() === "") {
    throw new Error("Invalid string rule");
  }
  return rule.value.trim();
}

function compileRule(rule: TranscodeFileRule): MongoQuery {
  const value = normalizeRuleValue(rule);
  const operators: Record<TranscodeWorkspaceOperator, string | null> = {
    eq: null,
    neq: "$ne",
    gt: "$gt",
    gte: "$gte",
    lt: "$lt",
    lte: "$lte",
    in: "$in",
    notIn: "$nin",
  };
  const operator = operators[rule.operator];
  return operator
    ? { [rule.field]: { [operator]: value } }
    : { [rule.field]: value };
}

function compileGroups(selection: TranscodeFileSelection): MongoQuery | null {
  const groups: MongoQuery[][] = [];
  selection.rules.forEach((rule, index) => {
    const joinBefore =
      index === 0 ? "and" : (selection.joins[index - 1] ?? "and");
    if (index === 0 || joinBefore === "and") groups.push([]);
    groups[groups.length - 1]!.push(compileRule(rule));
  });
  const conditions = groups.map((group) =>
    group.length === 1 ? group[0]! : { $or: group },
  );
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0]! : { $and: conditions };
}

export function buildTranscodeFileFilter(
  selection: TranscodeFileSelection,
): MongoQuery {
  if (selection.rules.length === 0) return {};
  try {
    return compileGroups(selection) ?? {};
  } catch {
    return { _id: { $in: [] } };
  }
}
