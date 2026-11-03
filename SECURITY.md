# Security policy

Heimdall holds credentials for your alert channels, identity provider and Git hosting, and it decides which agents to trust. We take vulnerability reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately with GitHub's [private vulnerability reporting](https://github.com/ohallord/heimdall/security/advisories/new) (**Security → Report a vulnerability** on the repository).

Please include:

- the affected component (hub, agent, installer, Helm chart) and the version or commit;
- steps to reproduce, or a proof of concept;
- the impact as you understand it.

What to expect:

- acknowledgement within **5 business days**;
- an initial assessment and severity within **14 days**;
- a fix or mitigation plan, with credit in the advisory unless you prefer to stay anonymous.

Please give us a reasonable chance to fix the issue before you disclose it publicly. We aim to release fixes within 90 days of the report.

## Supported versions

Heimdall is pre-1.0. Security fixes go to the latest release and the `main` branch only.

## Scope

In scope: the hub (`apps/hub`), the agent (`apps/agent`), the installers in `scripts/` and those served at `/install.sh`, the Helm chart and the Compose file.

Out of scope:

- deployments that ignore the [production checklist](docs/user-guide/installation.md#production-checklist), for example the public Compose defaults left in place on an exposed hub;
- the limitations already documented in [the security model](docs/design/security-model.md#known-limitations), such as rate limits held per process;
- vulnerabilities in third-party services Heimdall integrates with.

## Hardening guidance

See the [security model](docs/design/security-model.md) and the [security review](docs/security-review.md).
