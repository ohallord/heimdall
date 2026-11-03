export type LogRuleSeverity = "critical" | "high" | "medium" | "low";

export type LogRule = {
  id: string;
  name: string;
  category:
    | "ssh"
    | "sudo"
    | "reverse_shell"
    | "crypto_miner"
    | "webshell"
    | "privilege_escalation";
  severity: LogRuleSeverity;
  description: string;
  /** Case-insensitive patterns; any match fires the rule. */
  patterns: RegExp[];
  /**
   * false: record the match on the log line (searchable, tagged) but never
   * create an alert rule or notify. Defaults to true.
   */
  alert?: boolean;
};

/** Built-in log threat pack (auth abuse, shells, miners, webshells, privilege escalation). */
export const DEFAULT_LOG_RULES: readonly LogRule[] = [
  {
    id: "ssh_failed_password",
    name: "Failed SSH password",
    category: "ssh",
    severity: "medium",
    description: "Failed password / authentication failure on SSH",
    patterns: [
      /failed password/i,
      /authentication failure.*sshd/i,
      /Failed publickey for/i,
      /Invalid user .* from/i,
      /Disconnected from authenticating user .* \[preauth\]/i,
    ],
  },
  {
    id: "sudo_abuse",
    name: "Suspicious sudo",
    category: "sudo",
    severity: "high",
    description: "Failed sudo authentication or sudoers denial",
    patterns: [
      /sudo:.*authentication failure/i,
      /sudo:.*incorrect password attempts?/i,
      /sudo:.*authentication failed/i,
      /NOT in sudoers/i,
      /user NOT in sudoers file/i,
      /pam_unix\(sudo:auth\): authentication failure/i,
    ],
  },
  {
    // Every successful sudo logs COMMAND=; that is routine admin work, not an
    // incident. Tagged for search/audit only — denials alert via sudo_abuse.
    id: "sudo_command",
    name: "sudo command",
    category: "sudo",
    severity: "low",
    description: "Successful sudo command execution (audit only, no alert)",
    patterns: [/sudo:\s+\S+\s+:\s+.*COMMAND=/i],
    alert: false,
  },
  {
    id: "reverse_shell",
    name: "Reverse shell indicator",
    category: "reverse_shell",
    severity: "critical",
    description: "Common reverse-shell command strings",
    patterns: [
      /\/dev\/tcp\//i,
      /bash\s+-i\s+>&\s*\/dev\/tcp\//i,
      /nc\s+-[elp]/i,
      /ncat\s+.*-e\s+/i,
      /python[23]?\s+-c\s+['"].*socket/i,
      /perl\s+-e\s+['"].*socket/i,
      /php\s+-r\s+['"].*fsockopen/i,
      /socat\s+.*EXEC:/i,
      /mkfifo\s+\/tmp\/.*nc\s+/i,
    ],
  },
  {
    id: "crypto_miner",
    name: "Crypto miner indicator",
    category: "crypto_miner",
    severity: "critical",
    description: "Known miner binaries / stratum pool traffic",
    patterns: [
      /\bxmrig\b/i,
      /\bminerd\b/i,
      /\bcpu_miner\b/i,
      /stratum\+tcp:\/\//i,
      /stratum\+ssl:\/\//i,
      /mining\.pool/i,
      /nicehash\.com/i,
      /supportxmr\.com/i,
      /cryptonight/i,
      /--donate-level/i,
    ],
  },
  {
    id: "webshell_indicator",
    name: "Webshell / C2 download indicator",
    category: "webshell",
    severity: "critical",
    description: "Common webshell filenames and suspicious download-to-exec",
    patterns: [
      /\bc99\.php\b/i,
      /\br57\.php\b/i,
      /\bwso\.php\b/i,
      /\bb374k\b/i,
      /\.jsp\s+webshell/i,
      /cmd\.asp/i,
      /wget\s+.*\|\s*(ba)?sh/i,
      /curl\s+.*\|\s*(ba)?sh/i,
      /curl\s+.*-o\s+\/tmp\/.*&&\s*chmod\s+\+x/i,
    ],
  },
  {
    id: "privilege_escalation",
    name: "Privilege escalation indicator",
    category: "privilege_escalation",
    severity: "high",
    description: "Unexpected setuid bits, sudoers writes, or capability abuse",
    patterns: [
      /chmod\s+[0-7]*[4-7][0-7]{2}\b/i,
      /chmod\s+u\+s\b/i,
      /chown\s+root:.*\s+\/tmp\//i,
      /echo\s+.*\s*>>\s*\/etc\/sudoers/i,
      /visudo/i,
      /setcap\s+.*\+ep\b/i,
      /newgrp\s+root/i,
    ],
  },
] as const;

export function getLogRule(id: string): LogRule | undefined {
  return DEFAULT_LOG_RULES.find((r) => r.id === id);
}

export function logRuleAlerts(id: string): boolean {
  return getLogRule(id)?.alert !== false;
}
