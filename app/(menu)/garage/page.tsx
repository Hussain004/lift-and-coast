import type { Metadata } from "next";
import { ShowroomLoader } from "../../ShowroomLoader";
import { TeamSetup } from "../../TeamSetup";
import pageStyles from "../../page.module.css";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Garage · LIFT & COAST" };

export default function GaragePage() {
  return (
    <>
      <p className={styles.lede}>Choose your team and driver. Your pick carries into every mode.</p>
      <div className={pageStyles.garage}>
        <ShowroomLoader />
        <TeamSetup />
      </div>
    </>
  );
}
