# Beta Test Pack

Give this document to each wave of testers. Do **not** coach them through the
product. Observe where they get stuck.

## What this product is

IT Inventory shows **what needs fixing** across directory (Entra) and MDM
(Jamf / Intune / CSV): users without devices, devices without owners, disabled
accounts that still hold gear, stale check-ins, mismatches.

It is not a full CMDB. It is an exceptions inbox with enough context to act.

## Access

| Item | Value |
|------|--------|
| URL | https://it-inventory-saas-staging.onrender.com |
| Account | Provided separately (e-mail + temporary password) |
| Browser | Chrome, Edge, or Safari |

**Do not** enter real employee / device data in this beta. Use only the sample
organization you were given.

**Do not** share your password. Change it under Account if the invite asked you to.

## The 10 tasks

Work through these in order. Time yourself roughly. Skip only if blocked.

1. **Log in and tell us what needs attention** (first screen that answers this).
2. Find a **user who does not have a device**.
3. Find a **device without an owner**.
4. Find a **disabled user who still has an active device**.
5. Find a **stale device** (has not checked in recently).
6. Open one exception and **explain in your own words** what is wrong.
7. **Assign** that exception to yourself.
8. **Resolve** (or snooze) the exception with a short note.
9. Find a specific employee and list **which devices** they have.
10. Trigger a **sync or CSV import** (if your role allows) and say whether anything changed.

If you are read-only, skip tasks that need write access and note that.

## How to report a bug

One bug = one message (Slack / e-mail / form — whatever we shared with you).

Use a severity:

| Severity | Meaning | Example |
|----------|---------|---------|
| **P0 blocker** | Cannot use the product | Login broken; seeing another org’s data |
| **P1 critical** | Major feature unusable | Sync always fails; exceptions wrong; import corrupts data |
| **P2 important** | Works but hurts | Wrong counts; confusing label; slow page |
| **P3 cosmetic** | Polish | Spacing, icon, typo |

Include:

1. What you tried  
2. What you expected  
3. What happened (screenshot if useful)  
4. Your role (admin / IT / readonly)  
5. Severity  

Do **not** paste passwords, invite links, or connector secrets.

## Three questions at the end

1. What did you expect the product to do that it didn't?  
2. What was confusing or required explanation?  
3. If you had this tool at work tomorrow, what would you use it for first?

## What we measure (for us, not for you)

For each tester we note: time to first login, time to first useful exception,
tasks completed / failed / needing help. “I like it” alone is not enough feedback.
