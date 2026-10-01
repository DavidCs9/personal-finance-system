import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("recover-dsql-resources.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.live = {"Resources": {"MetadataTable": {"Type": "AWS::DynamoDB::Table", "DeletionPolicy": "Retain"},
                                   "DataEncryptionKey": {"Type": "AWS::KMS::Key"}},
                     "Outputs": {"Source": {"Value": {"Ref": "MetadataTable"}}},
                     "Parameters": {"Prompt": {"Type": "String"}}}
        self.desired = copy.deepcopy(self.live)
        self.desired["Resources"]["MetadataTable"]["Properties"] = {"Unexpected": "must not import"}
        self.desired["Resources"].update({
            "DsqlProjectionCluster": {"Type": "AWS::DSQL::Cluster", "DeletionPolicy": "Retain", "Properties": {"DeletionProtectionEnabled": True}},
            "DsqlProjectionRecovery": {"Type": "AWS::S3::Bucket", "DeletionPolicy": "Retain", "Properties": {"Key": {"Fn::GetAtt": ["DataEncryptionKey", "Arn"]}}},
            "DsqlProjectionSchemaLogs": {"Type": "AWS::Logs::LogGroup", "DeletionPolicy": "Retain", "Properties": {"LogGroupName": "/aws/lambda/personal-finance-v1-dsql-schema"}},
            "DsqlProjectionBootstrap": {"Type": "Custom::Bootstrap"},
        })
        self.events = [{"LogicalResourceId": name, "ResourceType": resource["Type"],
                        "ResourceStatus": "DELETE_SKIPPED", "PhysicalResourceId": f"physical-{index}"}
                       for index, (name, resource) in enumerate(self.desired["Resources"].items())
                       if name.startswith("DsqlProjection") and name != "DsqlProjectionBootstrap"]

    def test_import_isolated_from_all_application_updates_and_source_changes(self):
        template, imports = recovery.import_plan(self.live, self.desired, self.events)
        for key, value in self.live.items():
            if key == "Resources":
                for name, resource in value.items():
                    self.assertEqual(template["Resources"][name], resource)
            else:
                self.assertEqual(template[key], value)
        self.assertNotIn("DsqlProjectionBootstrap", template["Resources"])
        self.assertEqual(len(imports), 3)
        self.assertEqual(imports[0]["ResourceIdentifier"], {"Identifier": "physical-2"})
        self.assertEqual(self.live["Resources"]["MetadataTable"].get("Properties"), None)

    def test_successful_import_rerun_skips_owned_resources(self):
        template, _ = recovery.import_plan(self.live, self.desired, self.events)
        rerun, imports = recovery.import_plan(template, self.desired, self.events)
        self.assertEqual(rerun, template)
        self.assertEqual(imports, [])

    def test_no_failed_rollout_is_a_noop(self):
        self.assertEqual(recovery.import_plan(self.live, self.desired, []), (self.live, []))

    def test_original_artifact_restores_unicode_without_guessing_from_desired_code(self):
        original = copy.deepcopy(self.live)
        original["Resources"]["MetadataTable"]["Description"] = "Datos de David — México"
        original["Resources"]["MetadataTable"]["Metadata"] = {"schema": {"description": "Información financiera"}}
        damaged = copy.deepcopy(original)
        damaged["Resources"]["MetadataTable"]["Description"] = "Datos de David ? M?xico"
        damaged["Resources"]["MetadataTable"]["Metadata"]["schema"]["description"] = "Informaci?n financiera"
        damaged["Resources"]["DsqlProjectionAlreadyImported"] = {"Type": "AWS::Logs::LogGroup"}
        restored = recovery.restore_original_template(damaged, original)
        self.assertEqual(restored["Resources"]["MetadataTable"], original["Resources"]["MetadataTable"])
        self.assertIn("DsqlProjectionAlreadyImported", restored["Resources"])
        self.assertEqual(damaged["Resources"]["MetadataTable"]["Description"], "Datos de David ? M?xico")
        self.assertEqual(recovery.restore_original_template(original, original), original)

    def test_original_artifact_rejects_unrelated_changes_and_missing_resources(self):
        resource_changed, resource_missing, output_changed = [copy.deepcopy(self.live) for _ in range(3)]
        resource_changed["Resources"]["MetadataTable"]["Properties"] = {"Changed": True}
        del resource_missing["Resources"]["MetadataTable"]
        output_changed["Outputs"]["Source"]["Value"] = "different"
        for changed in [resource_changed, resource_missing, output_changed]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                recovery.restore_original_template(changed, self.live)

    def test_ambiguous_identity_unknown_type_missing_identifier_and_dependency_fail_closed(self):
        cases = [self.events + [{**self.events[0], "PhysicalResourceId": "another-cluster"}],
                 [{**self.events[0], "ResourceType": "AWS::DynamoDB::Table"}],
                 [{**self.events[0], "PhysicalResourceId": ""}]]
        for events in cases:
            with self.subTest(events=events), self.assertRaises(RuntimeError):
                recovery.import_plan(self.live, self.desired, events)
        self.desired["Resources"]["DsqlProjectionRecovery"]["DependsOn"] = ["DsqlProjectionBootstrap"]
        with self.assertRaises(RuntimeError):
            recovery.import_plan(self.live, self.desired, self.events)

    def test_non_import_or_incomplete_change_set_cannot_execute(self):
        _, imports = recovery.import_plan(self.live, self.desired, self.events)
        changes = [{"ResourceChange": {"Action": "Import", "ResourceType": item["ResourceType"],
                                       "LogicalResourceId": item["LogicalResourceId"]}} for item in imports]
        recovery.verify_changes(changes, imports)
        with self.assertRaises(RuntimeError):
            recovery.verify_changes(changes[:-1], imports)
        with self.assertRaises(RuntimeError):
            recovery.verify_changes(changes + [{"ResourceChange": {"Action": "Modify", "LogicalResourceId": "MetadataTable"}}], imports)

    def test_local_execution_and_wrong_account_are_rejected(self):
        with patch.dict(recovery.os.environ, {"GITHUB_REF": "refs/heads/feature"}), self.assertRaises(RuntimeError):
            recovery.main()
        with patch.object(recovery.Aws, "call", return_value={"Account": "wrong"}), self.assertRaises(RuntimeError):
            recovery.Aws().check_identity()

    def test_approved_job_preserves_parameters_and_checks_change_set_before_execution(self):
        _, imports = recovery.import_plan(self.live, self.desired, self.events)
        calls = []
        execution_role = f"arn:aws:iam::{recovery.ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-{recovery.ACCOUNT}-{recovery.REGION}"
        original_bytes = json.dumps(self.live).encode()
        def call(*args):
            calls.append(args)
            operation = args[:2]
            if operation == ("cloudformation", "describe-stacks"):
                return {"Stacks": [{"StackStatus": "UPDATE_ROLLBACK_COMPLETE", "RoleARN": execution_role,
                                    "Parameters": [{"ParameterKey": "Prompt", "ParameterValue": "private prompt"}]}]}
            if operation == ("cloudformation", "get-template"):
                return {"TemplateBody": self.live}
            if operation == ("cloudformation", "describe-stack-events"):
                return {"StackEvents": self.events}
            if operation == ("s3api", "put-object"):
                uploaded = json.loads(Path(args[args.index("--body") + 1]).read_text())
                self.assertEqual(uploaded["Resources"]["MetadataTable"], self.live["Resources"]["MetadataTable"])
            if operation == ("s3api", "get-object"):
                Path(args[-1]).write_bytes(original_bytes)
            if operation == ("cloudformation", "get-template-summary"):
                return {"ResourceIdentifierSummaries": [{"ResourceType": item["ResourceType"],
                         "LogicalResourceIds": [item["LogicalResourceId"]], "ResourceIdentifiers": list(item["ResourceIdentifier"])} for item in imports]}
            if operation == ("cloudformation", "create-change-set"):
                parameters = json.loads(args[args.index("--parameters") + 1])
                self.assertEqual(parameters, [{"ParameterKey": "Prompt", "UsePreviousValue": True}])
                self.assertNotIn("private prompt", str(args))
                self.assertEqual(args[args.index("--role-arn") + 1], execution_role)
                return {"Id": "import-change-set"}
            if operation == ("cloudformation", "describe-change-set"):
                return {"Changes": [{"ResourceChange": {"Action": "Import", "ResourceType": item["ResourceType"],
                                    "LogicalResourceId": item["LogicalResourceId"]}} for item in imports]}
            if operation == ("cloudformation", "list-stack-resources"):
                return {"StackResourceSummaries": [{"LogicalResourceId": item["LogicalResourceId"],
                        "PhysicalResourceId": next(iter(item["ResourceIdentifier"].values()))} for item in imports]}
            return {}
        with tempfile.TemporaryDirectory() as directory:
            desired = Path(directory) / "desired.json"
            desired.write_text(json.dumps(self.desired))
            with patch.dict(recovery.os.environ, {"GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push",
                            "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}), patch.object(recovery.sys, "argv", ["recover", str(desired)]), \
                 patch.object(recovery.Aws, "check_identity"), patch.object(recovery.Aws, "assume", return_value=recovery.Aws()), \
                 patch.object(recovery.Aws, "call", side_effect=call), patch("builtins.print"):
                with patch.object(recovery, "PRE_MIGRATION_TEMPLATE_SHA256", hashlib.sha256(original_bytes).hexdigest()):
                    recovery.main()
        operations = [args[:2] for args in calls]
        self.assertLess(operations.index(("cloudformation", "describe-change-set")), operations.index(("cloudformation", "execute-change-set")))
        self.assertFalse(any(args[0] in {"dynamodb", "dsql", "lambda"} for args in calls))


if __name__ == "__main__":
    unittest.main()
