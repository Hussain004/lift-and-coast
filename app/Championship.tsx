"use client";

import Link from "next/link";
import { objectiveFor, reputationTitle, seasonObjectives } from "@/lib/race/objectives";
import { useEffect, useState } from "react";
import {
  completedRounds,
  computeDriverStandings,
  computeTeamStandings,
  createSeason,
  isSeasonComplete,
  nextRoundIndex,
  seasonChampion,
  seasonTrackIds,
  SEASON_LENGTHS,
  totalRounds,
  weekendStage,
  type ChampionshipSeason,
  type SeasonLength,
} from "@/lib/race/championship";
import { clearSeason, loadSeason, saveSeason } from "@/lib/persistence/championship";
import { DEFAULT_RACE_LAPS, MAX_RIVALS, buildRaceUrl, type RaceUrlParams } from "@/lib/race/sessionSetup";
import { parseDriverCode, parseTeamId, TEAMS, useRosterSelection } from "@/lib/race/roster";
import { useSessionSetupPrefs } from "@/lib/race/sessionSetup";
import { TRACKS, getTrackName } from "@/lib/tracks/registry";
import styles from "./championship.module.css";

const TEAM_BY_ID = new Map(TEAMS.map((team) => [team.id, team]));

function teamName(id: string | null): string {
  return (id && TEAM_BY_ID.get(id)?.name) || "—";
}

function teamColor(id: string | null): string {
  const c = id ? TEAM_BY_ID.get(id)?.primaryColor : undefined;
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : "#8a8f99";
}

type Tab = "drivers" | "teams" | "calendar";

/**
 * Championship mode: the season, its standings and the next weekend. A
 * season is a calendar of rounds scored with the real points table; each
 * round records the whole field's classification (see Car.tsx), so the
 * tables below are the real drivers' and constructors' championships, not
 * the player against a single stand-in.
 */
export function Championship() {
  const [season, setSeason] = useState<ChampionshipSeason | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [length, setLength] = useState<SeasonLength>("calendar");
  const [tab, setTab] = useState<Tab>("drivers");
  const [confirmReset, setConfirmReset] = useState(false);
  const { teamId, driverCode } = useRosterSelection();
  const { timeOfDay, weather, difficulty } = useSessionSetupPrefs();

  useEffect(() => {
    let cancelled = false;
    loadSeason().then((saved) => {
      if (cancelled) return;
      setSeason(saved);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function startSeason() {
    const ids = seasonTrackIds(length, TRACKS.map((track) => track.id));
    const fresh = createSeason(ids, new Date().toISOString());
    setSeason(fresh);
    setTab("drivers");
    void saveSeason(fresh);
  }

  function resetSeason() {
    setSeason(null);
    setConfirmReset(false);
    void clearSeason();
  }

  if (!loaded) {
    return <div className={styles.card}>Loading season…</div>;
  }

  if (!season) {
    return (
      <div className={styles.card}>
        <div className={styles.kicker}>NEW SEASON</div>
        <h2 className={styles.heading}>Choose your calendar</h2>
        <div className={styles.lengths} role="radiogroup" aria-label="Season length">
          {SEASON_LENGTHS.map((option) => {
            const rounds = seasonTrackIds(option.id, TRACKS.map((t) => t.id)).length;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={length === option.id}
                className={styles.length}
                data-active={length === option.id ? "1" : undefined}
                onClick={() => setLength(option.id)}
              >
                <strong>{option.label}</strong>
                <span>{rounds} rounds · {option.blurb}</span>
              </button>
            );
          })}
        </div>
        <p className={styles.note}>
          Full grid, real points (25-18-15-12-10-8-6-4-2-1). Each weekend: optional practice, knockout
          qualifying, then a {DEFAULT_RACE_LAPS}-lap race. Your team and AI level come from the Garage and
          Grand Prix setup.
        </p>
        <button type="button" className={styles.primary} onClick={startSeason} data-nav-default>
          START SEASON
        </button>
      </div>
    );
  }

  const drivers = computeDriverStandings(season);
  const teams = computeTeamStandings(season);
  const complete = isSeasonComplete(season);
  const next = nextRoundIndex(season);
  const champion = seasonChampion(season);
  const done = completedRounds(season);
  const total = totalRounds(season);
  const you = drivers.find((d) => d.isPlayer);
  const yourPosition = you ? drivers.indexOf(you) + 1 : null;
  const playerTeam = you?.teamId ?? parseTeamId(teamId);
  const objectives = seasonObjectives(season, playerTeam);
  const nextObjective = complete ? null : objectiveFor(playerTeam, next);

  return (
    <div className={styles.wrap}>
      <div className={styles.summary}>
        <div>
          <div className={styles.kicker}>
            {complete ? "SEASON COMPLETE" : `ROUND ${next + 1} OF ${total}`}
          </div>
          <h2 className={styles.heading}>
            {complete
              ? champion?.isPlayer
                ? "You are the world champion"
                : `${champion?.name ?? champion?.code ?? "—"} takes the title`
              : getTrackName(season.rounds[next].trackId)}
          </h2>
          <div className={styles.progress} aria-hidden="true">
            <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
          </div>
          {nextObjective && (
            <div className={styles.note}>
              TEAM OBJECTIVE · {nextObjective.label.toUpperCase()}
            </div>
          )}
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>YOU</dt>
            <dd>{yourPosition ? `P${yourPosition}` : "—"}</dd>
          </div>
          <div>
            <dt>POINTS</dt>
            <dd>{you?.points ?? 0}</dd>
          </div>
          <div>
            <dt>WINS</dt>
            <dd>{you?.wins ?? 0}</dd>
          </div>
          <div title={reputationTitle(objectives.reputation)}>
            <dt>REPUTATION</dt>
            <dd>{objectives.reputation}</dd>
          </div>
        </dl>
      </div>

      {!complete && <Weekend season={season} next={next} base={{
        team: parseTeamId(teamId),
        driver: parseDriverCode(driverCode),
        tod: timeOfDay,
        weather,
        difficulty,
      }} />}

      <div className={styles.tabs} role="tablist" aria-label="Standings">
        {(
          [
            ["drivers", "DRIVERS"],
            ["teams", "CONSTRUCTORS"],
            ["calendar", "CALENDAR"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={styles.tab}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "drivers" && (
        drivers.length === 0 ? (
          <p className={styles.empty}>No rounds raced yet. The table fills in after your first race.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>POS</th>
                <th>DRIVER</th>
                <th>TEAM</th>
                <th>WINS</th>
                <th>PTS</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d, i) => (
                <tr key={d.key} data-you={d.isPlayer ? "1" : undefined}>
                  <td className={styles.pos}>{i + 1}</td>
                  <td>
                    <span className={styles.driver}>
                      <i style={{ background: teamColor(d.teamId) }} />
                      <b>{d.code}</b>
                      <span>{d.name ?? (d.isPlayer ? "You" : "")}</span>
                    </span>
                  </td>
                  <td className={styles.team}>{teamName(d.teamId)}</td>
                  <td>{d.wins || ""}</td>
                  <td className={styles.points}>{d.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "teams" && (
        teams.length === 0 ? (
          <p className={styles.empty}>No rounds raced yet.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>POS</th>
                <th>TEAM</th>
                <th>WINS</th>
                <th>PTS</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t, i) => (
                <tr key={t.teamId} data-you={t.teamId === you?.teamId ? "1" : undefined}>
                  <td className={styles.pos}>{i + 1}</td>
                  <td>
                    <span className={styles.driver}>
                      <i style={{ background: teamColor(t.teamId) }} />
                      <b>{teamName(t.teamId)}</b>
                    </span>
                  </td>
                  <td>{t.wins || ""}</td>
                  <td className={styles.points}>{t.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "calendar" && (
        <ol className={styles.calendar}>
          {season.rounds.map((round, i) => {
            const winner = round.result?.find((r) => r.position === 1);
            return (
              <li key={`${round.trackId}-${i}`} data-state={round.playerPosition !== null ? "done" : i === next ? "next" : "later"}>
                <span className={styles.round}>R{i + 1}</span>
                <span className={styles.roundTrack}>{getTrackName(round.trackId)}</span>
                <span className={styles.roundResult}>
                  {round.playerPosition !== null
                    ? `P${round.playerPosition}${winner && !winner.isPlayer ? ` · won by ${winner.code}` : ""}${objectives.outcomes[i] === null ? "" : objectives.outcomes[i] ? " · objective met" : " · objective missed"}`
                    : i === next
                      ? round.qualiSpot !== null
                        ? `NEXT · QUALIFIED P${round.qualiSpot}`
                        : "NEXT"
                      : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className={styles.footerActions}>
        {confirmReset ? (
          <>
            <span className={styles.note}>Abandon this season? Its results are lost.</span>
            <button type="button" className={styles.danger} onClick={resetSeason}>
              YES, RESET
            </button>
            <button type="button" className={styles.ghost} onClick={() => setConfirmReset(false)}>
              KEEP RACING
            </button>
          </>
        ) : (
          <button type="button" className={styles.ghost} onClick={() => (complete ? resetSeason() : setConfirmReset(true))}>
            {complete ? "NEW SEASON" : "RESET SEASON"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The next weekend: practice (optional), qualifying, then the race. */
function Weekend({
  season,
  next,
  base,
}: {
  season: ChampionshipSeason;
  next: number;
  base: Pick<RaceUrlParams, "team" | "driver" | "tod" | "weather" | "difficulty">;
}) {
  const round = season.rounds[next];
  const stage = weekendStage(season, next);
  // Championship weekends run the full grid (see MAX_RIVALS).
  const url = { ...base, track: round.trackId, champ: next, rivals: MAX_RIVALS };
  const qualified = round.qualiSpot !== null;
  return (
    <div className={styles.weekend}>
      <div className={styles.weekendSteps}>
        <Link className={styles.step} href={buildRaceUrl({ ...url, mode: "practice", laps: DEFAULT_RACE_LAPS })}>
          <small>01</small> PRACTICE
        </Link>
        {(stage === "qualifying" || stage === "race") && (
          <Link
            className={styles.step}
            data-primary={!qualified ? "1" : undefined}
            data-nav-default={!qualified ? true : undefined}
            href={buildRaceUrl({ ...url, mode: "qualifying", qformat: "knockout" })}
          >
            <small>02</small> {qualified ? `RE-QUALIFY (P${round.qualiSpot})` : "QUALIFYING"}
          </Link>
        )}
        {(stage === "qualifying" || stage === "race") && !qualified && (
          <Link className={styles.stepAlt} href={buildRaceUrl({ ...url, mode: "qualifying", qformat: "oneshot" })}>
            ONE-SHOT QUALI
          </Link>
        )}
        {stage === "race" && qualified && (
          <Link
            className={styles.step}
            data-primary="1"
            data-nav-default
            href={buildRaceUrl({ ...url, mode: "race", laps: DEFAULT_RACE_LAPS, grid: round.qualiSpot ?? undefined })}
          >
            <small>03</small> RACE FROM P{round.qualiSpot}
          </Link>
        )}
      </div>
    </div>
  );
}
