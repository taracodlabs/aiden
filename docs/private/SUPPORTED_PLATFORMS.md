# Supported platform matrix

| Platform | Status | Evidence and limits |
|---|---|---|
| Windows 11 x64 | Supported; primary | Physical Windows acceptance plus Windows CI. Product support should target current supported Windows 11 builds. |
| Node 20 | Supported | Repository CI and packaged acceptance. Native modules must match the runtime ABI. |
| Node 22 | Supported; preferred development runtime | Repository CI, Windows physical acceptance, and current productization validation target Node 22.23.1. |
| Node 24 | Unsupported until certified | Do not infer support from successful startup. Native ABI, PTY, SQLite, package, and process-tree acceptance are required. |
| macOS | Partially validated | CI-supported where the matrix passes; no broad physical product certification is claimed. |
| Linux | Partially validated | CI-supported where the matrix passes; distribution-specific and desktop/browser physical certification is limited. |
| Other platforms | Experimental | No support claim without an explicit test and support decision. |

`aiden doctor` projects this matrix as `supported`, `partially_validated`, `experimental`, or `unsupported`. It must not upgrade CI evidence into a physical support claim.

