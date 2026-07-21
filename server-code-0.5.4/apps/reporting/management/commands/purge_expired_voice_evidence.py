from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.reporting.models import VoiceInteractionEvidence


class Command(BaseCommand):
    help = "清理过期语音交互证据的音频引用和转写内容，保留最小审计行"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="只统计，不写入")

    def handle(self, *args, **options):
        queryset = VoiceInteractionEvidence.objects.filter(
            status__in=[
                VoiceInteractionEvidence.Status.CAPTURED,
                VoiceInteractionEvidence.Status.TRANSCRIBED,
                VoiceInteractionEvidence.Status.FAILED,
            ],
            retention_until__lte=timezone.now(),
        )
        count = queryset.count()
        if options["dry_run"]:
            self.stdout.write(f"将清理 {count} 条过期语音证据")
            return
        changed = 0
        for record in queryset.iterator():
            with transaction.atomic():
                locked = VoiceInteractionEvidence.objects.select_for_update().get(pk=record.pk)
                if locked.status == VoiceInteractionEvidence.Status.EXPIRED or locked.retention_until > timezone.now():
                    continue
                locked.status = VoiceInteractionEvidence.Status.EXPIRED
                locked.transcription_status = VoiceInteractionEvidence.TranscriptionStatus.FAILED
                locked.audio_metadata = {"purged": True}
                locked.transcript = {}
                locked.transcript_engine = ""
                locked.transcript_confidence = None
                locked.save(update_fields=["status", "transcription_status", "audio_metadata", "transcript", "transcript_engine", "transcript_confidence", "updated_at"])
                changed += 1
        self.stdout.write(f"已清理 {changed} 条过期语音证据，保留最小审计行")
