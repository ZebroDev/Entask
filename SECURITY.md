**English** · [繁體中文](SECURITY.zh-TW.md)
# Security Policy

## Purpose

Entask is intended to be self-hosted software. Security reports help protect users who deploy Entask for project, team, worklog, and performance-related data.

This policy explains how to report a suspected security vulnerability privately. It applies to the current release and is reviewed as the project evolves.

## Do Not Report Security Issues Publicly

Please **do not** report suspected security vulnerabilities through:

- Public GitHub Issues
- Pull Requests
- GitHub Discussions
- Public chat rooms or social media
- Any other public project channel

Public disclosure before a fix is available may expose Entask users and self-hosted deployments to unnecessary risk. If an issue contains credentials, personal information, customer data, or other secrets, do not publish it anywhere. Contact the maintainer privately instead.

## How to Report a Vulnerability

Send a private report by email to [security@zebrodev.com](mailto:security@zebrodev.com).

Use the following subject line:

```text
[Entask Security] Vulnerability report
```

`security@zebrodev.com` is the primary security reporting address and is actively monitored.

If a report cannot be sent by email, do not post the details publicly. Contact [contact@zebrodev.com](mailto:contact@zebrodev.com) and state that you need a private channel for an Entask security report without including sensitive technical details in the initial public message. This fallback is an intentional additional private channel (not a replacement for `security@`); both addresses are monitored, and the goal is to establish a private channel before any details are exchanged.

## Accidental or Unauthorized Submissions

If you accidentally submit confidential information, personal data, credentials, malware, or unauthorized third-party material to a public project channel, contact [contact@zebrodev.com](mailto:contact@zebrodev.com) immediately. Include the affected URL or commit identifier, but do not repeat the sensitive content in the message or disclose it publicly.

The maintainer may remove, restrict, quarantine, or replace affected material where reasonably practicable and may take other measures required by law. Removal of material does not by itself revoke any license already granted for that material under the project's open-source license (see the `LICENSE` file). Where personal data or confidential business information is involved, the maintainer will assess whether additional privacy, incident-response, or legal steps are required.

## Information to Include

Please include as much of the following information as can be shared safely:

- A short description of the vulnerability;
- The affected Entask version, release, or commit;
- The deployment method, such as Docker or source installation;
- The operating system, runtime, database, reverse proxy, and hosting environment when relevant;
- Clear steps to reproduce the issue;
- The expected and actual behavior;
- The potential impact, including affected users, permissions, data, or deployment components;
- A minimal proof of concept or sanitized logs, if available;
- Any known workaround or mitigation;
- Whether the issue may have been exploited in a real deployment.

Please remove passwords, API keys, access tokens, session cookies, private keys, personal information, customer data, and confidential business information before sending the report.

## Report Handling

The maintainer will make reasonable efforts to:

1. Confirm receipt when possible.
2. Verify whether the report affects Entask or an official release artifact.
3. Assess severity, exploitability, affected versions, and potential exposure.
4. Request additional information through the private channel when needed.
5. Coordinate a fix, mitigation, or release when appropriate.
6. Determine a disclosure timeline that considers user safety and the availability of a tested fix.
7. Credit the reporter if the reporter agrees and it is appropriate to do so.

The project currently does not promise a fixed acknowledgement time, remediation time, bounty, or service-level agreement. Response timing depends on severity, reproducibility, maintainer capacity, affected versions, and the complexity of a safe fix.

## Coordinated Disclosure

Please allow reasonable time for investigation and remediation before making vulnerability details public. ZebroDev will coordinate disclosure with the reporter when practical. The final disclosure approach may include a security advisory, release note, changelog entry, mitigation notice, or another appropriate public announcement.

A reporter should not publish a working exploit, sensitive deployment details, or affected customer information before an agreed disclosure plan is in place.

## Scope

This policy covers vulnerabilities in:

- Entask source code maintained in the official ZebroDev repository;
- Official Entask release artifacts;
- Official installation or deployment instructions when they create a material security risk;
- Security-sensitive default configuration distributed by the project.

Issues in operating systems, databases, reverse proxies, hosting providers, third-party dependencies, or user-managed infrastructure should also be reported to the relevant upstream maintainer when appropriate. If a third-party issue affects Entask, include the upstream report or advisory information in the private report when it can be shared safely.

## Deployment Responsibilities

Self-hosted operators remain responsible for securing their deployment. This includes access control, secret management, network exposure, TLS configuration, backups, database protection, operating-system updates, runtime updates, dependency updates, monitoring, and incident response.

Entask documentation and source code do not guarantee that a deployment is secure for every environment or use case. Operators should evaluate the security requirements of their own organization before exposing Entask to sensitive or public workloads.

## Supported Versions

Security fixes are provided for the latest **1.0.x** release; users should test updates promptly. Older releases and development versions are not supported and should not be assumed to receive security fixes.

## Legal and Privacy Notice

Please do not send information that is not necessary to investigate the issue. Security reports may contain personal information or confidential technical details; the reporter should use an appropriate organizational account and follow applicable privacy and disclosure requirements.

This policy describes the intended security reporting process. It is not a warranty, incident-response contract, service-level agreement, or legal advice.
