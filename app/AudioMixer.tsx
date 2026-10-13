"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_MIXER, MIXER_CHANNELS, loadMixer, saveMixer, subscribeMixer } from "@/lib/settings/mixerPrefs";
import styles from "./sessionSetup.module.css";

/** Five volume sliders: master, engines, effects, engineer radio, menu sounds. */
export function AudioMixer() {
  const mixer = useSyncExternalStore(subscribeMixer, loadMixer, () => DEFAULT_MIXER);
  return (
    <div className={styles.mixer}>
      {MIXER_CHANNELS.map((channel) => (
        <label key={channel.id} className={styles.mixerRow}>
          <span className={styles.mixerName}>
            <b>{channel.label}</b>
            <small>{channel.blurb}</small>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(mixer[channel.id] * 100)}
            onChange={(e) => saveMixer({ ...mixer, [channel.id]: Number(e.target.value) / 100 })}
            aria-label={`${channel.label} volume`}
            className={styles.slider}
          />
          <output className={styles.readout}>{Math.round(mixer[channel.id] * 100)}</output>
        </label>
      ))}
    </div>
  );
}
