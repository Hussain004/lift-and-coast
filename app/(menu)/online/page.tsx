import type { Metadata } from "next";
import { Multiplayer } from "../../Multiplayer";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Multiplayer · LIFT & COAST" };

export default function OnlinePage() {
  return (
    <div className={styles.narrow}>
      <p className={styles.lede}>Race friends in real time: open a room, share the code, the host picks the circuit.</p>
      <Multiplayer />
    </div>
  );
}
