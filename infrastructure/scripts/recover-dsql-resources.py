#!/usr/bin/env python3
"""Native import of detached DSQL resources, only inside deploy-production.

CloudFormation cannot import resources while updating existing ones. Preserve the
live template verbatim and add only retained resources from rollback events; the
normal CDK deployment applies the reviewed application update afterwards.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ACCOUNT = "225989371926"
REGION = "us-east-2"
STACK = "PersonalFinanceV1"
PREFIX = "DsqlProjection"
# Immutable CDK template from the last successful production rollout before #145.
# GetTemplate corrupts its Unicode descriptions/schema to question marks.
PRE_MIGRATION_TEMPLATE_SHA256 = "4b7dec2e3164baca19e6564f242c2347d2612b4e48ac55cb7494ab4a52c6eae6"
IDENTIFIERS = {
    "AWS::DSQL::Cluster": "Identifier",
    "AWS::S3::Bucket": "BucketName",
    "AWS::Logs::LogGroup": "LogGroupName",
    "AWS::Backup::BackupVault": "BackupVaultName",
}


def restore_original_template(current, original):
    """Restore only verified GetTemplate Unicode loss, never application changes."""
    def lossy(value):
        if isinstance(value, str):
            return "".join(character if ord(character) < 128 else "?" for character in value)
        if isinstance(value, list):
            return [lossy(item) for item in value]
        if isinstance(value, dict):
            return {lossy(key): lossy(item) for key, item in value.items()}
        return value

    restored = copy.deepcopy(current)
    for key, value in original.items():
        if key == "Resources":
            for name, resource in value.items():
                live = current["Resources"].get(name)
                if live != resource and live != lossy(resource):
                    raise RuntimeError("Original deployment artifact differs from live application resource")
                restored["Resources"][name] = copy.deepcopy(resource)
        else:
            if current.get(key) != value and current.get(key) != lossy(value):
                raise RuntimeError("Original deployment artifact differs from live stack configuration")
            restored[key] = copy.deepcopy(value)
    return restored


def import_plan(current, desired, events):
    """Build an import-only template; never modify or delete existing resources."""
    retained = {}
    for event in events:
        logical_id = event.get("LogicalResourceId", "")
        if not logical_id.startswith(PREFIX) or logical_id in current["Resources"]:
            continue
        if event.get("ResourceStatus") != "DELETE_SKIPPED":
            continue
        kind = event.get("ResourceType")
        physical_id = event.get("PhysicalResourceId")
        if kind not in IDENTIFIERS or not physical_id:
            raise RuntimeError("Unexpected retained DSQL resource type or missing identifier")
        retained.setdefault(logical_id, set()).add((kind, physical_id))

    template = copy.deepcopy(current)
    imports = []
    for logical_id, identities in sorted(retained.items()):
        if len(identities) != 1:
            raise RuntimeError("Ambiguous retained DSQL resource identity")
        kind, physical_id = next(iter(identities))
        resource = desired["Resources"].get(logical_id)
        if not resource or resource["Type"] != kind or resource.get("DeletionPolicy") != "Retain":
            raise RuntimeError("Retained resource does not match reviewed retained definition")
        # Properties have to remain unchanged at import. Current recovery
        # resources reference only the existing encryption key and AWS tokens.
        template["Resources"][logical_id] = copy.deepcopy(resource)
        imports.append({"ResourceType": kind, "LogicalResourceId": logical_id,
                        "ResourceIdentifier": {IDENTIFIERS[kind]: physical_id}})

    allowed = set(template["Resources"]) | set(template.get("Parameters", {}))
    def validate_refs(node):
        if isinstance(node, dict):
            reference = node.get("Ref")
            attribute = node.get("Fn::GetAtt")
            if reference and reference not in allowed and not reference.startswith("AWS::"):
                raise RuntimeError("Import has a dependency outside the live or retained resources")
            if attribute and (attribute[0] if isinstance(attribute, list) else attribute.split(".")[0]) not in allowed:
                raise RuntimeError("Import has an unresolved resource attribute")
            for value in node.values():
                validate_refs(value)
        elif isinstance(node, list):
            for value in node:
                validate_refs(value)
    for item in imports:
        resource = template["Resources"][item["LogicalResourceId"]]
        dependencies = resource.get("DependsOn", [])
        if isinstance(dependencies, str):
            dependencies = [dependencies]
        if any(dependency not in allowed for dependency in dependencies):
            raise RuntimeError("Import has an unresolved dependency")
        validate_refs(resource)
    return template, imports


def verify_changes(changes, imports):
    expected = {item["LogicalResourceId"]: item["ResourceType"] for item in imports}
    observed = {}
    for change in changes:
        resource = change.get("ResourceChange", {})
        logical_id = resource.get("LogicalResourceId")
        if resource.get("Action") != "Import" or logical_id in observed:
            raise RuntimeError("Recovery change set contains a non-import change")
        observed[logical_id] = resource.get("ResourceType")
    if observed != expected:
        raise RuntimeError("Recovery change set does not match retained resources")


class Aws:
    def __init__(self, environment=None):
        self.environment = os.environ.copy() if environment is None else environment

    def call(self, *args):
        result = subprocess.run(["aws", *args, "--region", REGION, "--output", "json"],
                                env=self.environment, capture_output=True, text=True, timeout=900)
        if result.returncode:
            # Native CLI errors may contain parameters; do not dump them into
            # public Actions logs. Operators retain the native change set/events.
            raise RuntimeError(f"AWS {args[0]} {args[1]} failed; inspect native stack events")
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def check_identity(self):
        identity = self.call("sts", "get-caller-identity")
        if identity["Account"] != ACCOUNT:
            raise RuntimeError("Recovery AWS account mismatch")

    def assume(self, role):
        credentials = self.call("sts", "assume-role", "--role-arn", f"arn:aws:iam::{ACCOUNT}:role/{role}",
                                "--role-session-name", "personal-finance-dsql-recovery")["Credentials"]
        environment = self.environment.copy()
        environment.pop("AWS_PROFILE", None)
        environment.update(AWS_ACCESS_KEY_ID=credentials["AccessKeyId"],
                           AWS_SECRET_ACCESS_KEY=credentials["SecretAccessKey"],
                           AWS_SESSION_TOKEN=credentials["SessionToken"])
        return Aws(environment)


def main():
    if os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_EVENT_NAME") != "push":
        raise RuntimeError("Recovery runs only in the approved main push deployment")
    base = Aws()
    base.check_identity()
    deploy = base.assume(f"cdk-hnb659fds-deploy-role-{ACCOUNT}-{REGION}")
    deploy.check_identity()
    stack = deploy.call("cloudformation", "describe-stacks", "--stack-name", STACK)["Stacks"][0]
    if stack["StackStatus"] not in {"UPDATE_ROLLBACK_COMPLETE", "UPDATE_COMPLETE", "CREATE_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"}:
        raise RuntimeError("Stack is not in a stable recovery state")
    current = deploy.call("cloudformation", "get-template", "--stack-name", STACK, "--template-stage", "Original")["TemplateBody"]
    if isinstance(current, str):
        current = json.loads(current)
    desired = json.loads(Path(sys.argv[1]).read_text())
    events = deploy.call("cloudformation", "describe-stack-events", "--stack-name", STACK)["StackEvents"]
    template, imports = import_plan(current, desired, events)
    if not imports:
        print("DSQL recovery: no detached retained resources to import")
        return
    execution_role = f"arn:aws:iam::{ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-{ACCOUNT}-{REGION}"
    if stack.get("RoleARN") != execution_role:
        raise RuntimeError("Unexpected CloudFormation execution role")
    run_id = os.environ["GITHUB_RUN_ID"]
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    if not run_id.isdecimal() or not attempt.isdecimal():
        raise RuntimeError("Invalid recovery run identity")
    name = f"dsql-recovery-{run_id}-{attempt}"
    bucket = f"cdk-hnb659fds-assets-{ACCOUNT}-{REGION}"
    key = f"dsql-recovery/{name}.json"
    publisher = base.assume(f"cdk-hnb659fds-file-publishing-role-{ACCOUNT}-{REGION}")
    with tempfile.TemporaryDirectory() as directory:
        original_path = Path(directory) / "original-template.json"
        publisher.check_identity()
        publisher.call("s3api", "get-object", "--bucket", bucket,
                       "--key", f"{PRE_MIGRATION_TEMPLATE_SHA256}.json", str(original_path))
        original_bytes = original_path.read_bytes()
        if hashlib.sha256(original_bytes).hexdigest() != PRE_MIGRATION_TEMPLATE_SHA256:
            raise RuntimeError("Original deployment template checksum mismatch")
        current = restore_original_template(current, json.loads(original_bytes))
        template, imports = import_plan(current, desired, events)
        path = Path(directory) / "import-template.json"
        path.write_text(json.dumps(template, ensure_ascii=False), encoding="utf-8")
        publisher.check_identity()
        publisher.call("s3api", "put-object", "--bucket", bucket, "--key", key, "--body", str(path))
        deploy.check_identity()
        template_url = f"https://{bucket}.s3.{REGION}.amazonaws.com/{key}"
        summary = deploy.call("cloudformation", "get-template-summary", "--template-url", template_url)
        for item in imports:
            native = [entry for entry in summary["ResourceIdentifierSummaries"]
                      if entry["ResourceType"] == item["ResourceType"] and item["LogicalResourceId"] in entry["LogicalResourceIds"]]
            if len(native) != 1 or not set(item["ResourceIdentifier"]).issubset(native[0]["ResourceIdentifiers"]):
                raise RuntimeError("Native import identifier does not match recovery mapping")
        parameters = [{"ParameterKey": parameter["ParameterKey"], "UsePreviousValue": True}
                      for parameter in stack.get("Parameters", [])]
        result = deploy.call("cloudformation", "create-change-set", "--stack-name", STACK,
                             "--change-set-name", name, "--change-set-type", "IMPORT",
                             "--template-url", template_url,
                             "--resources-to-import", json.dumps(imports), "--parameters", json.dumps(parameters),
                             "--capabilities", "CAPABILITY_NAMED_IAM", "--role-arn", execution_role)
    change_set = result["Id"]
    deploy.call("cloudformation", "wait", "change-set-create-complete", "--change-set-name", change_set)
    changes = deploy.call("cloudformation", "describe-change-set", "--change-set-name", change_set)
    verify_changes(changes["Changes"], imports)
    print(f"DSQL recovery: importing {len(imports)} retained resources; change set {change_set}")
    deploy.check_identity()
    deploy.call("cloudformation", "execute-change-set", "--change-set-name", change_set)
    deploy.call("cloudformation", "wait", "stack-import-complete", "--stack-name", STACK)
    owned = deploy.call("cloudformation", "list-stack-resources", "--stack-name", STACK)["StackResourceSummaries"]
    for item in imports:
        matching = [resource for resource in owned if resource["LogicalResourceId"] == item["LogicalResourceId"]]
        if len(matching) != 1 or matching[0]["PhysicalResourceId"] != next(iter(item["ResourceIdentifier"].values())):
            raise RuntimeError("Imported physical identity differs from retained resource")
    print("DSQL recovery: native import completed; normal reviewed deployment may proceed")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        # Error messages above are static; JSON/parser/key errors are not printed.
        print(str(error) if isinstance(error, RuntimeError) else "DSQL recovery input or AWS response invalid", file=sys.stderr)
        sys.exit(1)
