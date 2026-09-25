# Data Processing Agreement (template)

This is a **pilot / free-tier template**, not legal advice. Replace bracketed
fields before attaching it to a paid contract. The processor is the operator of
this IT Inventory SaaS deployment; each customer organization is the controller
of employee and device personal data it uploads or syncs.

## Parties

- **Controller:** [Customer legal name], [address], [contact]
- **Processor:** [Operator legal name], [address], [contact]
- **Effective date:** [date]

## Subject matter and duration

The Processor hosts a multi-tenant IT inventory service (people, devices,
imports, issues, audit logs, connector credentials) for the Controller for the
term of the service agreement and until erasure or export is completed.

## Nature and purpose of processing

Provide inventory, import/sync from directory and MDM sources, exception
detection, auditability, and admin exports. Processing is limited to what the
Controller configures and uploads.

## Types of personal data

Work identity and device metadata typically including: name, work e-mail /
UPN, department, job title, manager e-mail, device serial / asset tag, MDM
identifiers, assignment history, and technical logs. No special-category data
is required for the service.

## Categories of data subjects

Employees, contractors and other workforce members of the Controller whose
records the Controller imports or syncs.

## Processor obligations

1. Process personal data only on documented instructions from the Controller
   (including configuration inside the product).
2. Ensure persons authorized to process data are bound by confidentiality.
3. Implement appropriate technical and organizational measures (TLS in transit,
   scrypt password hashing, per-organization isolation, encrypted connector
   secrets when `SAAS_CONNECTOR_KEY` is set, role-based access).
4. Not engage a subprocessor except as listed in `SUBPROCESSORS.md`, and notify
   the Controller of material changes.
5. Assist with data subject requests (access, erasure, portability) using the
   product features: person delete with scrubbing, organization JSON export,
   organization deletion, retention cleanup.
6. Assist with security and DPIA inquiries reasonably, using existing
   documentation and test evidence.
7. Delete or return personal data after the end of the service, subject to
   legal retention of security / audit records as described below.
8. Make available information necessary to demonstrate compliance and allow
   audits agreed in writing (reasonable notice, no disruption of other tenants).

## Controller obligations

The Controller determines what data to import, configures retention, manages
member access, and is responsible for lawful basis toward data subjects
(typically employment / legitimate interest for IT asset management).

## International transfers

Production hosting for the reference deployment is in the EU (Render Frankfurt).
If the Controller enables connectors to vendors outside the EU (e.g. Microsoft
Graph, Jamf), those transfers are under the Controller’s configuration and the
vendor’s terms.

## Retention

Defaults (configurable per organization in **Settings → Privacy**):

| Store | Default |
|-------|---------|
| Import previews | 7 days |
| Applied / cancelled import batches | 30 days |
| Applied import row payloads | scrubbed to non-identifying keys after apply / cleanup |
| Audit logs | 365 days |

Person erasure removes the `people` row and scrubs matching e-mails / names from
import row JSON, issue details, manager links, asset source-presence, and audit
`details_json`. Audit **action** rows may remain for accountability
(legitimate interest / legal obligation) with personal values replaced by
`[erased]`.

## Security incidents

The Processor will notify the Controller without undue delay after becoming
aware of a personal-data breach affecting the Controller’s tenant, and provide
available facts needed for the Controller’s Article 33/34 assessment. Evidence
sources on the free tier typically include application audit logs and host
provider logs (Render).

## Liability and governing law

[To be completed with commercial terms.]

## Signatures

Controller: ______________________  Date: __________

Processor: ______________________  Date: __________
