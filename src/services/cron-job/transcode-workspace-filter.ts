export type TranscodeWorkspaceField = "_id" | "status" | "plan.planType";

export type TranscodeWorkspaceOperator =
  "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn";
export interface TranscodeWorkspaceRule {
  id: string;
  field: TranscodeWorkspaceField;
  operator: TranscodeWorkspaceOperator;
  value: string | string[] | number | boolean;
}

export interface TranscodeWorkspaceSelection {
  mode: "all" | "rules";
  match: "all" | "any";
  joins: Array<"and" | "or">;
  rules: TranscodeWorkspaceRule[];
}

type MongoQuery = Record<string, unknown>;

const FIELDS = new Set<TranscodeWorkspaceField>([
  "_id",
  "status",
  "plan.planType",
]);
const LIST_OPERATORS = new Set<TranscodeWorkspaceOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
]);

export const DEFAULT_TRANSCODE_WORKSPACE_SELECTION: TranscodeWorkspaceSelection =
  {
    mode: "all",
    match: "all",
    joins: [],
    rules: [],
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

export function normalizeTranscodeWorkspaceSelection(
  value: unknown,
): TranscodeWorkspaceSelection {
  if (value === undefined || value === null)
    return DEFAULT_TRANSCODE_WORKSPACE_SELECTION;
  if (!value || typeof value !== "object")
    return { ...DEFAULT_TRANSCODE_WORKSPACE_SELECTION, mode: "rules" };
  const source = value as Record<string, unknown>;
  const rules =
    Array.isArray(source.rules) && source.rules.length <= 20
      ? source.rules.filter((rule): rule is TranscodeWorkspaceRule => {
          if (!rule || typeof rule !== "object") return false;
          const candidate = rule as Record<string, unknown>;
          return (
            typeof candidate.id === "string" &&
            FIELDS.has(candidate.field as TranscodeWorkspaceField) &&
            ["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn"].includes(
              String(candidate.operator),
            )
          );
        })
      : [];

  return {
    // Query presence is the source of truth. `mode` remains in the shape only
    // for backward compatibility with settings written by older admin builds.
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
  };
}

function normalizeRuleValue(rule: TranscodeWorkspaceRule): unknown {
  if (!LIST_OPERATORS.has(rule.operator)) throw new Error("Invalid operator");
  if (rule.operator === "in" || rule.operator === "notIn") {
    const values = uniqueStrings(rule.value);
    if (values.length === 0) throw new Error("Invalid list rule");
    return values;
  }
  if (typeof rule.value !== "string" || rule.value.trim() === "")
    throw new Error("Invalid string rule");
  return rule.value.trim();
}

function compileRule(rule: TranscodeWorkspaceRule): MongoQuery {
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

/**
 * OR binds tighter than AND, matching the admin DataFilter UI:
 * A AND B OR C => A AND (B OR C).
 */
function compileRuleGroups(
  rules: TranscodeWorkspaceRule[],
  joins: Array<"and" | "or">,
): MongoQuery | null {
  const groups: MongoQuery[][] = [];
  rules.forEach((rule, index) => {
    const joinBefore = index === 0 ? "and" : (joins[index - 1] ?? "and");
    if (index === 0 || joinBefore === "and") groups.push([]);
    groups[groups.length - 1]!.push(compileRule(rule));
  });

  const conditions = groups.map((group) =>
    group.length === 1 ? group[0]! : { $or: group },
  );
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0]! : { $and: conditions };
}

export function buildTranscodeWorkspaceFilter(
  selection: TranscodeWorkspaceSelection,
): MongoQuery {
  if (selection.rules.length === 0) return {};
  try {
    return compileRuleGroups(selection.rules, selection.joins) ?? {};
  } catch {
    return { _id: { $in: [] } };
  }
}
