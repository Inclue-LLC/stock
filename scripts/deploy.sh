#!/usr/bin/env bash
# Cloud Run（＋Firebase Hosting）へデプロイする。何度実行しても大丈夫。
#   使い方: scripts/deploy.sh <Firebase のプロジェクトID>
# 事前に: gcloud auth login（Firebase Hosting も使う場合は firebase login）
set -euo pipefail

PROJECT="${1:?使い方: scripts/deploy.sh <Firebase のプロジェクトID>}"
REGION="asia-northeast1"   # 東京
SERVICE="stock"
cd "$(dirname "$0")/.."

echo "== プロジェクト: $PROJECT"
gcloud config set project "$PROJECT" >/dev/null

echo "== 必要な API を有効化"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com firebasehosting.googleapis.com

echo "== Firestore データベース"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native
fi

echo "== 実行用アカウントの権限"
NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="${NUM}-compute@developer.gserviceaccount.com"
for ROLE in roles/datastore.user roles/run.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" \
    --condition=None >/dev/null
done

echo "== 履歴検索用のインデックス（作成済みなら何もしない）"
for FIELD in location_id product_id batch_id; do
  gcloud firestore indexes composite create --collection-group=movements \
    --field-config="field-path=$FIELD,order=ascending" \
    --field-config="field-path=created_at,order=descending" --async >/dev/null 2>&1 || true
done

echo "== Cloud Run へデプロイ（数分かかります）"
# 最大インスタンス数 1: メモリ上のデータを1か所に保つため
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --max-instances 1 --memory 512Mi --timeout 600 --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

if command -v firebase >/dev/null 2>&1; then
  echo "== Firebase Hosting・Firestore ルールをデプロイ"
  firebase deploy --only hosting,firestore:rules --project "$PROJECT" --non-interactive
  echo
  echo "完了: https://${PROJECT}.web.app （Cloud Run の URL: $URL）"
else
  echo
  echo "完了: $URL"
  echo "（firebase コマンドがないため Firebase Hosting は省略しました。npm install -g firebase-tools で使えます）"
fi
