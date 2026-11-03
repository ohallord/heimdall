import { DEFAULT_LOG_RULES, type LogRule, type LogRuleSeverity } from "./rules";

export type LogMatch = {
  ruleId: string;
  ruleName: string;
  category: LogRule["category"];
  severity: LogRuleSeverity;
  pattern: string;
};

export type EvaluatedLine = {
  line: string;
  matches: LogMatch[];
};

const SEVERITY_RANK: Record<LogRuleSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function highestSeverity(
  matches: LogMatch[],
): LogRuleSeverity | null {
  if (matches.length === 0) return null;
  return matches.reduce(
    (best, m) =>
      SEVERITY_RANK[m.severity] < SEVERITY_RANK[best] ? m.severity : best,
    matches[0]!.severity,
  );
}

/** Evaluate one log line against the rule pack. */
export function evaluateLogLine(
  line: string,
  rules: readonly LogRule[] = DEFAULT_LOG_RULES,
): EvaluatedLine {
  const matches: LogMatch[] = [];
  const text = line ?? "";
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        matches.push({
          ruleId: rule.id,
          ruleName: rule.name,
          category: rule.category,
          severity: rule.severity,
          pattern: pattern.source,
        });
        break;
      }
    }
  }
  return { line: text, matches };
}

export function evaluateLogLines(
  lines: string[],
  rules: readonly LogRule[] = DEFAULT_LOG_RULES,
): EvaluatedLine[] {
  return lines.map((line) => evaluateLogLine(line, rules));
}

/** Metric keys used by threshold alerts when a log rule fires. */
export function logMatchMetric(ruleId: string): string {
  return `log_match:${ruleId}`;
}
