"use client";

import { useRef, useState } from "react";
import { exportSaveData, importSaveData } from "@/lib/persistence/saveBundle";
import styles from "./page.module.css";

const FILENAME = "lift-and-coast-save.json";
const MESSAGE_CLEAR_MS = 4000;

/**
 * Plan section 10: "Export/import: a 'dump my save' button (JSON file) and
 * re-import - backup and device transfer without a backend." Lives on the
 * home screen, not the race HUD - this is a menu/account action, not
 * something you'd reach for mid-drive.
 */
export function SaveTransfer() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");

  function showMessage(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(""), MESSAGE_CLEAR_MS);
  }

  async function handleExport() {
    const bundle = await exportSaveData();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = FILENAME;
    // Some browsers require the element to be in the document for a
    // programmatic click to trigger a download at all. Revoking the blob
    // URL has to wait a tick too - <a download> reads it asynchronously, so
    // revoking on the very next line (before the browser has read it) can
    // kill the download in Chrome.
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showMessage("Save exported.");
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      await importSaveData(JSON.parse(text));
      showMessage("Save imported. Bests and championship updated.");
    } catch {
      showMessage("Could not import that file - is it a Lift & Coast save?");
    }
  }

  return (
    <div className={styles.saveTransfer}>
      <div className={styles.saveTransferButtons}>
        <button type="button" className={styles.saveTransferButton} onClick={handleExport}>
          Export save
        </button>
        <button
          type="button"
          className={styles.saveTransferButton}
          onClick={() => fileInputRef.current?.click()}
        >
          Import save
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        className={styles.hiddenFileInput}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleImportFile(file);
        }}
      />
      {message && <p className={styles.saveTransferMessage}>{message}</p>}
    </div>
  );
}
