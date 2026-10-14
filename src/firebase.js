// Firebase への接続。
// - 本番（Firebase Hosting）: Hosting が提供する /__/firebase/init.json から設定を読む（設定を埋め込む必要なし）
// - 開発・テスト: VITE_EMULATOR=1 または URL に ?emulator を付けると Firestore エミュレータに接続する

import { initializeApp } from "firebase/app";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

export async function connectFirebase() {
  const params = new URLSearchParams(location.search);
  const emulator = import.meta.env.VITE_EMULATOR || params.has("emulator");
  if (emulator) {
    const app = initializeApp({ projectId: import.meta.env.VITE_PROJECT_ID || "demo-stock", apiKey: "demo" });
    const db = getFirestore(app);
    const [host, port] = (import.meta.env.VITE_EMULATOR_HOST || params.get("emulator") || "127.0.0.1:8081").split(":");
    connectFirestoreEmulator(db, host, Number(port));
    return db;
  }
  const res = await fetch("/__/firebase/init.json");
  if (!res.ok) {
    throw new Error("Firebase の設定を読み込めませんでした。Firebase Hosting で公開しているか、"
      + "Firebase コンソールでウェブアプリを登録しているか確認してください。");
  }
  return getFirestore(initializeApp(await res.json()));
}
