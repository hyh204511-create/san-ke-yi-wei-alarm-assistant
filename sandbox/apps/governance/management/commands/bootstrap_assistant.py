import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.governance.models import AssistantProfile, RoleAssignment
from apps.governance.services import assign_role


class Command(BaseCommand):
    help = "从环境变量中的密码创建或更新本地实名助手账号"

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--display-name", required=True)
        parser.add_argument("--employee-code", required=True)
        parser.add_argument("--role", choices=RoleAssignment.Role.values, required=True)
        parser.add_argument("--password-env", default="ASSISTANT_BOOTSTRAP_PASSWORD")

    def handle(self, *args, **options):
        password = os.environ.get(options["password_env"])
        if not password or len(password) < 12:
            raise CommandError(f"环境变量 {options['password_env']} 必须提供至少12位密码")
        user, _ = get_user_model().objects.get_or_create(username=options["username"])
        user.set_password(password)
        user.is_active = True
        user.save()
        AssistantProfile.objects.update_or_create(
            user=user,
            defaults={"display_name": options["display_name"], "employee_code": options["employee_code"], "is_active": True},
        )
        assign_role(user=user, role=options["role"], assigned_by=user)
        self.stdout.write(self.style.SUCCESS(f"实名助手账号已就绪: {user.username} / {options['role']}"))
