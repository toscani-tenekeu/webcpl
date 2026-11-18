// Site logs rotate weekly; existing servers get the rule when the agent starts.
import { existsSync } from 'node:fs'
import { writeAtomic } from './lib.ts'

const RULE = `# Written by Webcpl. The *.bytes.log files are emptied by the agent and not rotated here.
/var/log/webcpl/*/*.access.log /var/log/webcpl/*/*.error.log /var/log/webcpl/*/*.apache-error.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        [ -s /run/nginx.pid ] && kill -USR1 "$(cat /run/nginx.pid)" 2>/dev/null || true
        apache2ctl graceful >/dev/null 2>&1 || true
    endscript
}
`

export function ensureLogrotate() {
  if (existsSync('/etc/logrotate.d') && !existsSync('/etc/logrotate.d/webcpl')) writeAtomic('/etc/logrotate.d/webcpl', RULE)
}
