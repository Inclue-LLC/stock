import "./style.css";
import { onDataChange, start } from "./app.js";
import { getState, init, subscribe } from "./db.js";
import { connectFirebase } from "./firebase.js";

const root = document.getElementById("app");

function showError(message) {
  root.innerHTML = `<div class="loading"><b>接続できませんでした</b><br>${message.replace(/[<>&]/g, "")}</div>`;
}

try {
  init(await connectFirebase());
  let started = false;
  subscribe(() => {
    if (!started) {
      started = true;
      start(root, getState);
    } else onDataChange();
  }, (e) => showError(e.message));
} catch (e) {
  showError(e.message);
}
