"""Check Oracle Always Free shape capacity. Never creates a VM or paid resource."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import oci

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--profile", default="SYNAPSE_ORACLE")
args = parser.parse_args()
state = Path(__file__).resolve().parents[1] / ".local/oracle"
if not (state / "config").exists():
    parser.error("Run oracle-login.ps1 with the account home region first.")
try:
    config = oci.config.from_file(str(state / "config"), args.profile)
    signer = oci.auth.signers.SecurityTokenSigner(
        Path(config["security_token_file"]).read_text(),
        oci.signer.load_private_key_from_file(config["key_file"]),
    )
    identity = oci.identity.IdentityClient(config, signer=signer, timeout=(10, 30))
    regions = identity.list_region_subscriptions(config["tenancy"]).data
    home = next(region.region_name for region in regions if region.is_home_region)
    if config["region"] != home:
        parser.error("Authenticate in the account home region to inspect Always Free capacity.")
    ads = identity.list_availability_domains(config["tenancy"]).data
    compute = oci.core.ComputeClient(config, signer=signer, timeout=(10, 30))
    results = []
    for ad in ads:
        checks = [("VM.Standard.A1.Flex", cpu, ram) for cpu, ram in [(2, 12), (2, 4), (1, 6), (1, 4)]]
        shapes = compute.list_shapes(compartment_id=config["tenancy"], availability_domain=ad.name).data
        if any(shape.shape == "VM.Standard.E2.1.Micro" for shape in shapes):
            checks.append(("VM.Standard.E2.1.Micro", None, None))
        details = []
        for shape, cpu, ram in checks:
            options = {"instance_shape": shape}
            if cpu is not None:
                options["instance_shape_config"] = oci.core.models.CapacityReportInstanceShapeConfig(ocpus=cpu, memory_in_gbs=ram)
            details.append(oci.core.models.CreateCapacityReportShapeAvailabilityDetails(**options))
        report = compute.create_compute_capacity_report(oci.core.models.CreateComputeCapacityReportDetails(
            compartment_id=config["tenancy"], availability_domain=ad.name,
            shape_availabilities=details,
        )).data
        for shape in report.shape_availabilities:
            result = {"availabilityDomain": ad.name.split(":")[-1], "shape": shape.instance_shape,
                      "ocpus": getattr(shape.instance_shape_config, "ocpus", None),
                      "memoryGiB": getattr(shape.instance_shape_config, "memory_in_gbs", None),
                      "status": shape.availability_status}
            results.append(result)
            print(json.dumps(result), flush=True)
    (state / "capacity-latest.json").write_text(json.dumps({
        "checkedAt": datetime.now(timezone.utc).isoformat(), "homeRegion": home,
        "results": results,
    }, indent=2), encoding="utf-8")
except oci.exceptions.ServiceError as error:
    raise SystemExit(f"Oracle request failed: HTTP {error.status}, {error.code}. Refresh or repeat browser sign-in if expired.")
