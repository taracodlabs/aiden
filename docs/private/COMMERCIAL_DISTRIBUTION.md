# Commercial distribution decision record

## Options

| Model | Source exposure | Updates and rollback | Subscription enforcement | Windows/native support | Assessment |
|---|---|---|---|---|---|
| Private npm registry | Package contents remain inspectable | Familiar but weak desktop rollback | Registry access controls downloads, not already-installed code | Native ABI remains a support burden | Useful for internal CI, not the primary customer experience. |
| Desktop installer | Bundled JavaScript remains inspectable without further packaging | Strong signed installer/update path is possible | Local entitlement plus service validation | Best Windows onboarding and native dependency control | Strong client delivery foundation. |
| Bundled executable | Raises casual inspection cost, not a secrecy boundary | Requires signed artifact/update infrastructure | Same local limitations | Can simplify runtime dependency handling | Optional packaging layer, not a licensing or security solution. |
| Signed update service | Metadata and artifacts can be verified and rolled back | Best controlled channels and revocation | Ties maintained releases to valid channels | Requires signing-key operations and CDN reliability | Required production foundation. |
| Local client plus hosted services | Local source remains inspectable; managed capability stays server-side | Client and service can evolve independently | Service validates account and entitlement | Preserves offline Community core while funding managed value | Best long-term commercial model. |

## Recommendation

Start with a signed Windows desktop installer plus a signed update service, backed by a local-first client and narrowly scoped hosted Pro services. Use a private package registry only for internal build inputs. Do not publish a Pro package to the public npm registry.

The installer should pin the supported Node/native ABI or carry a controlled runtime, verify artifact SHA-256 and signatures, support rollback, and expose clear offline behavior. Signing keys must remain outside the repository and CI logs. Entitlement is a product-behavior control, not the sole moat; maintained workflows, relay, collaboration, support, and hosted services provide the durable commercial boundary.

Commercial distribution remains **LEGAL REVIEW REQUIRED** while the rights inventory is YELLOW.

