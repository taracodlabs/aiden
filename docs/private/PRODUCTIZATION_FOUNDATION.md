# Productization foundation

## Existing authorities retained

- `cli/v4/doctor.ts` remains the canonical diagnostic command.
- `core/v4/workbench/systemReadiness.ts` remains the Workbench readiness authority.
- `core/v4/license` remains a compatibility path while signed commercial entitlements are introduced.
- `core/v4/update` remains the Community npm update path.

## New commercial contracts

- `EditionAuthority`: centralized capability evaluation; safety capabilities always pass.
- `EntitlementAuthority`: verifies signed claims, maintains an atomic local cache, exposes calm states, and contains no payment logic.
- `ProductUpdateChannel`: normalized `community-stable`, `pro-stable`, and `pro-preview` metadata with signature and digest verification.
- `LocalProductMetrics`: local-only first-success milestones without prompt, file, account, credential, or content payloads.
- `buildOnboardingPlan`: projects existing Workbench readiness into a skippable first-run plan instead of creating a second readiness engine.

## Billing integration boundary

No approved account/billing/entitlement service contract was found that can safely be selected as the commercial authority in this pass. The entitlement refresh provider is therefore provider-neutral and injectable. Tests use deterministic signed claims. No fake checkout, subscription, or payment UI is introduced.

## First-run contract

The readiness-backed flow is: check this computer, connect AI, browser access, coding setup, Apps, ready. Browser, coding, and Apps remain optional when the user's goal does not require them. First-success choices are outcome-oriented: work on a codebase, research using browser, work with Apps, or create something. Failures retain the readiness detail, available action, and recheck path rather than leading with raw transport exceptions.

