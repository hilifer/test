#!/bin/sh
# 每日备份数据库与文章。crontab 示例（每天 03:30）：
#   30 3 * * * /opt/yr-sites/deploy/backup.sh /opt/yr-sites/deploy/led-na >> /var/log/yr-backup.log 2>&1
# 建议再用 rclone 同步 BACKUP_DIR 到对象存储（S3 / R2 / OSS）。
set -e
DIR=${1:?usage: backup.sh <region-dir>}
BACKUP_DIR=${BACKUP_DIR:-$DIR/backups}
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M)
for f in "$DIR"/data/db/*.sqlite; do
  [ -f "$f" ] && sqlite3 "$f" ".backup '$BACKUP_DIR/$(basename "$f" .sqlite)-$STAMP.sqlite'" 2>/dev/null || cp "$f" "$BACKUP_DIR/$(basename "$f" .sqlite)-$STAMP.sqlite"
done
tar -czf "$BACKUP_DIR/news-$STAMP.tgz" -C "$DIR/data" news
find "$BACKUP_DIR" -type f -mtime +30 -delete
echo "backup ok $STAMP"
