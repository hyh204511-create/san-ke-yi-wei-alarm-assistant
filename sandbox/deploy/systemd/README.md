# systemd maintenance templates

These files are templates for a native Linux/venv deployment. Replace the example paths, create the `assistant` service account, and copy the files without the `.example` suffix into `/etc/systemd/system/`.

Before enabling the daily timer:

1. Run each retention command manually with `--dry-run` and review the output.
2. Confirm the data owner has approved the retention and archive policy.
3. Run `systemctl daemon-reload`, then enable and start the timers.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now assistant-expire-action-leases.timer
sudo systemctl enable --now assistant-daily-maintenance.timer
systemctl list-timers 'assistant-*'
```

For Docker deployments, use the equivalent `docker compose exec assistant python manage.py ...` commands from the main deployment guide instead of these native venv units.
