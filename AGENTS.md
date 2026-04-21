# Security Hackathon Guidelines (agent summary)

## Goal
Help hackathon participants build quickly without risking production systems, production data, or excessive permissions.

## Git
you should use git for version control on the project. Commit regularly with good commit descriptions.

## Non-negotiables
- Do not use production data.
	- Use staging environments and newly created test data.
	- Any exception requires Security team approval (ask in #security).
- Do not connect hacks to production systems.
	- Any exception requires Security team approval (ask in #security).
	- Production changes still require normal processes (PRs, reviews, deployments).

## Tool / integration guardrails
- If experimenting with a new tool that needs access to corporate systems (GCP, Slack, Google, Notion, Airtable, etc.), coordinate a brief assessment with Johan.

## AI tooling options (increasing sophistication)
- Claude Chat: chat-based prompts, Projects, Skills; can connect to common work tools.
- Claude Cowork: agent-style workflows, can work on files; supports scheduling.
- Notion AI Custom Agents: autonomous workflows inside Notion; good choice for Slack bots; can be set up for non-technical users.
- Claude Managed Agents: developer-oriented managed agent runtime; requires more manual setup and service connections.
- Claude Code / Cursor: AI-assisted coding; best for building software directly.
- Custom AI app: build your own app locally or on GCP with dedicated keys.

## Access rules
- Default path: request access in #it.
- Notion AI Custom Agents: request in #it; Johan will co-create the agent with the requester.
- Custom AI apps / API keys: request in #it; use dedicated keys and follow onboarding if connecting to corporate systems.

## Naming convention
- General: label hackathon resources as hackathon-<name>.
- GitHub: repo name hackathon-<name>; add Gigsters team as Admin.
- GCP: project name gigs-hackathon-<name>; create under folder: gigs.com > sandbox > gigs-republic > grx.
- Gigs API/Dashboard: do not use production projects or gigscli universe token access. Use new staging hackathon-<name> projects in the Gigs Hackathons org.

## Deployment guidance
- Single-page sites: Google Drive.
- Web apps with backend: gigs.com > sandbox > gigs-republic > grx.
- Brownfield (Backbone / Dashboard / Metronome): You can run these locally and deploy them together to a vm.

## Post-hackathon cleanup
- If one-off: delete all resources, accounts, API keys; delete GCP projects; archive GitHub repos within 30 days (by May 21, 2026).
- If graduating: coordinate with Johan and Ethan to move into a maintained production setup.