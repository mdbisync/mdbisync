# Security reports

The security reports of the final releases of mdbisync. Each final release
carries its report as the release asset `security-report.md`, together with
`security-summary.json`, the machine-readable summary behind the security
image in the README. Once a release is published, its report is also added
here, named after the release (for example `v1.0.0.md`).

Each report lists the scans that ran on the release, their versions, the open
findings of severity critical and high, every dismissed finding with its
reason, and the [accepted risks](../accepted-risks.md).

The dependencies are not part of a report: a release can gain a known
vulnerability long after it was built, so they are checked again every six
hours by the "Dependency scan" workflow. Its latest run is the current
dependency report of the latest release, and `dependency-scan.json` on the
`security-status` branch holds that run's counts. The release's own
`dependency-scan.json` asset is the result at its build and never changes.
The release also carries `sbom.spdx.json`, the SPDX SBOM of its bundled
packages.
