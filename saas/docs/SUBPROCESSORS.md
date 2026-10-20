# Subprocessors

Operators of this SaaS deployment may use the following subprocessors to host
and run the service. Update this list when you add or change providers, and
notify customers before a material change.

| Subprocessor | Purpose | Region (reference deploy) | Notes |
|--------------|---------|---------------------------|-------|
| Render | Application hosting + managed PostgreSQL | Frankfurt (EU) | Free / starter plans; no paid add-ons required for pilots |
| Customer-chosen MDM / IdP APIs (Microsoft Entra / Intune Graph, Jamf Pro, Kandji, etc.) | Live sync when the customer connects credentials | Per vendor | Controller configures; processor stores encrypted credentials only when `SAAS_CONNECTOR_KEY` is set |

## Not used on the free pilot path

No paid analytics, error tracking, transactional e-mail, or object-storage
backup provider is required. If you later add Sentry, Postmark, Scaleway TEM,
or S3-compatible backup storage, list them here with an EU region preference.

## Customer responsibility

Directory and MDM vendors process workforce data under the customer’s own
contracts with those vendors. This product only calls their APIs with
credentials the customer supplies.
