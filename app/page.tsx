"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";

const VIEWER_POLL_MS = 15000;

type ChatLine = {
  id: string;
  user: string;
  text: string;
  at: number;
};

type TopChatter = {
  user: string;
  count: number;
};

type ViewerResponse = {
  viewers: number;
  live: boolean;
};

type ChatterEntry = {
  name: string;
  count: number;
};

type ParsedPing = {
  type: "PING";
  payload: string;
};

type ParsedPrivmsg = {
  type: "PRIVMSG";
  user: string;
  userKey: string;
  text: string;
};

type ParsedLine = ParsedPing | ParsedPrivmsg;

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 }
};

const MAX_CHAT_MESSAGES = 12;

function sanitizeChannel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function unescapeTagValue(value: string) {
  return value
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function parseChatLine(raw: string): ParsedLine | null {
  if (raw.startsWith("PING")) {
    return { type: "PING", payload: raw.split(":")[1] ?? "tmi.twitch.tv" };
  }

  const match = raw.match(
    /^(?:@[^ ]+ )?:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.+)$/
  );
  if (!match) {
    return null;
  }

  const matchUser = match[1] ?? "unknown";
  const matchText = match[2] ?? "";
  const userKey = matchUser.toLowerCase();
  let displayName = matchUser;

  if (raw.startsWith("@")) {
    const spaceIndex = raw.indexOf(" ");
    const tagPart = raw.slice(1, spaceIndex);
    const displayTag = tagPart
      .split(";")
      .find((entry) => entry.startsWith("display-name="));
    if (displayTag) {
      const [, value] = displayTag.split("=");
      if (value) {
        displayName = unescapeTagValue(value);
      }
    }
  }

  return {
    type: "PRIVMSG",
    user: displayName?.trim() ? displayName : matchUser,
    userKey,
    text: matchText
  };
}

function formatWait(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a bit";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  if (minutes <= 0) return `${remaining}s`;
  return `${minutes}m ${remaining}s`;
}

export default function Home() {
  const [channelInput, setChannelInput] = useState("");
  const [channel, setChannel] = useState("");
  const [isTracking, setIsTracking] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [uniqueChatters, setUniqueChatters] = useState(0);
  const [totalMessages, setTotalMessages] = useState(0);
  const [lowMessageChatters, setLowMessageChatters] = useState(0);
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [topChatters, setTopChatters] = useState<TopChatter[]>([]);

  const [viewerCount, setViewerCount] = useState(0);
  const [peakViewers, setPeakViewers] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [lastViewerAt, setLastViewerAt] = useState<number | null>(null);

  const [elapsed, setElapsed] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const messageCountsRef = useRef<Map<string, ChatterEntry>>(new Map());
  const startTimeRef = useRef<number | null>(null);
  const trackingRef = useRef(false);

  useEffect(() => {
    trackingRef.current = isTracking;
  }, [isTracking]);

  useEffect(() => {
    let isMounted = true;
    fetch("/api/twitch/start", { method: "GET" })
      .then((res) => res.json())
      .then((payload) => {
        if (!isMounted) return;
        if (payload?.retryAfter && payload.retryAfter > 0) {
          setCooldownSeconds(payload.retryAfter);
        }
      })
      .catch(() => null);
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const id = setInterval(() => {
      setCooldownSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownSeconds]);

  const engagement = useMemo(() => {
    if (!viewerCount) return 0;
    return (uniqueChatters / viewerCount) * 100;
  }, [uniqueChatters, viewerCount]);

  const mpm = useMemo(() => {
    if (!elapsed) return 0;
    return totalMessages / (elapsed / 60);
  }, [totalMessages, elapsed]);

  const resetStats = () => {
    setUniqueChatters(0);
    setTotalMessages(0);
    setLowMessageChatters(0);
    setChatLines([]);
    setTopChatters([]);
    setViewerCount(0);
    setPeakViewers(0);
    setIsLive(false);
    setLastViewerAt(null);
    setElapsed(0);
    messageCountsRef.current = new Map();
    startTimeRef.current = null;
  };

  const stopTracking = () => {
    setIsTracking(false);
    setChannel("");
    setError(null);
    wsRef.current?.close();
    wsRef.current = null;
    resetStats();
  };

  const startTracking = async () => {
    const cleaned = sanitizeChannel(channelInput);
    if (!cleaned) {
      setError("Enter a valid channel name.");
      return;
    }
    setError(null);
    if (isStarting || cooldownSeconds > 0) return;

    setIsStarting(true);
    try {
      const response = await fetch("/api/twitch/start", { method: "POST" });
      if (response.status === 429) {
        const payload = await response.json().catch(() => null);
        const retryAfter = payload?.retryAfter ?? 0;
        setCooldownSeconds(retryAfter);
        const wait = formatWait(retryAfter);
        setError(`Rate limit: try again in ${wait}.`);
        return;
      }
      if (!response.ok) {
        setError("Unable to start tracking. Please try again.");
        return;
      }

      const payload = await response.json().catch(() => null);
      if (payload?.retryAfter && payload.retryAfter > 0) {
        setCooldownSeconds(payload.retryAfter);
      } else {
        setCooldownSeconds(60);
      }

      resetStats();
      setChannelInput(cleaned);
      setChannel(cleaned);
      setIsTracking(true);
      startTimeRef.current = Date.now();
      setElapsed(0);
    } catch (err) {
      setError("Unable to start tracking. Please try again.");
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    if (!isTracking) {
      return;
    }

    const id = setInterval(() => {
      if (!startTimeRef.current) return;
      const nextElapsed = Math.floor(
        (Date.now() - startTimeRef.current) / 1000
      );
      setElapsed(nextElapsed);
    }, 1000);

    return () => clearInterval(id);
  }, [isTracking]);

  useEffect(() => {
    if (!isTracking || !channel) {
      return;
    }

    const nick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${channel}`);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const lines = event.data.split("\r\n").filter(Boolean);
      for (const raw of lines) {
        const parsed = parseChatLine(raw);
        if (!parsed) continue;
        if (parsed.type === "PING") {
          ws.send(`PONG :${parsed.payload}`);
          continue;
        }
        if (parsed.type === "PRIVMSG") {
          const user = parsed.user;
          const userKey = parsed.userKey;
          const text = parsed.text;

          setTotalMessages((prev) => prev + 1);

          const counts = messageCountsRef.current;
          const existing = counts.get(userKey) ?? { name: user, count: 0 };
          existing.count += 1;
          existing.name = user;
          counts.set(userKey, existing);
          setUniqueChatters(counts.size);

          let lowCount = 0;
          for (const value of counts.values()) {
            if (value.count < 3) lowCount += 1;
          }
          setLowMessageChatters(lowCount);

          const top = Array.from(counts.values())
            .sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              return a.name.localeCompare(b.name);
            })
            .slice(0, 5)
            .map((entry) => ({ user: entry.name, count: entry.count }));
          setTopChatters(top);

          setChatLines((prev) => {
            const next = [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                user,
                text,
                at: Date.now()
              }
            ];
            return next.slice(-MAX_CHAT_MESSAGES);
          });
        }
      }
    };

    ws.onerror = () => {
      if (trackingRef.current) {
        setError("Chat connection error. Check the channel name.");
      }
    };

    ws.onclose = () => {
      if (trackingRef.current) {
        setError("Chat connection closed.");
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [channel, isTracking]);

  useEffect(() => {
    if (!isTracking || !channel) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const fetchViewers = async () => {
      try {
        const response = await fetch(
          `/api/twitch/viewers?channel=${encodeURIComponent(channel)}`,
          { signal: controller.signal }
        );

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const wait = retryAfter ? `${retryAfter}s` : "a bit";
          setError(`Rate limit reached. Retry in ${wait}.`);
          return;
        }

        if (!response.ok) {
          let message = "Viewer fetch failed.";
          try {
            const payload = await response.json();
            if (payload?.error) {
              message = `Viewer fetch failed: ${payload.error}.`;
            }
          } catch (err) {
            message = "Viewer fetch failed.";
          }
          setError(message);
          return;
        }

        const payload = (await response.json()) as ViewerResponse;
        if (cancelled) return;
        setViewerCount(payload.viewers);
        setIsLive(payload.live);
        setLastViewerAt(Date.now());

        setPeakViewers((prev) => Math.max(prev, payload.viewers));
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError("Viewer fetch failed.");
        }
      }
    };

    fetchViewers();
    const interval = setInterval(fetchViewers, VIEWER_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      controller.abort();
    };
  }, [channel, isTracking]);

  const stats = [
    {
      label: "Live Viewers (CCV)",
      value: viewerCount.toLocaleString(),
      sub: isLive ? "Live now" : "Offline"
    },
    {
      label: "Peak Viewers",
      value: peakViewers.toLocaleString(),
      sub: "Session peak"
    },
    {
      label: "Unique Chatters",
      value: uniqueChatters.toLocaleString(),
      sub: "Distinct users"
    },
    {
      label: "Total Messages",
      value: totalMessages.toLocaleString(),
      sub: "Chat volume"
    },
    {
      label: "Chatters < 3 Msgs",
      value: lowMessageChatters.toLocaleString(),
      sub: "Low activity"
    },
    {
      label: "Messages per Minute",
      value: mpm.toFixed(1),
      sub: "Chat velocity"
    },
    {
      label: "Engagement",
      value: `${engagement.toFixed(2)}%`,
      sub: "Chatters / viewers"
    }
  ];

  return (
    <div className="page">
      <header className="hero">
        <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          F*CK Botters
        </motion.h1>
        <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          Real-time Twitch channel telemetry powered by live chat signals and
          viewer polling.
        </motion.p>
      </header>

      <section className="control-panel">
        <motion.div className="panel" variants={cardVariants} initial="hidden" animate="show">
          <h2 className="panel-title">Channel Control</h2>
          <div className="control-row">
            <input
              className="input"
              placeholder="Twitch channel name"
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              disabled={isTracking}
            />
            <button
              className={`button ${isTracking ? "stop" : "start"}`}
              onClick={isTracking ? stopTracking : startTracking}
              disabled={!isTracking && (isStarting || cooldownSeconds > 0)}
            >
              {isStarting
                ? "Starting..."
                : isTracking
                  ? "Stop Tracking"
                  : cooldownSeconds > 0
                    ? `Wait ${formatWait(cooldownSeconds)}`
                    : "Start Tracking"}
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </motion.div>

        <motion.div className="panel" variants={cardVariants} initial="hidden" animate="show">
          <h2 className="panel-title">Session Status</h2>
          <div className="status-stack">
            <div className="status-pill">
              <span className={`status-dot ${isLive ? "live" : ""}`}></span>
              {isLive ? "Live now" : "Offline"}
            </div>
            <div className="status-meta">Duration: {formatDuration(elapsed)}</div>
            <div className="status-meta">
              Last viewer poll:{" "}
              {lastViewerAt ? new Date(lastViewerAt).toLocaleTimeString() : "--"}
            </div>
            <div className="status-meta">
              Channel: {channel ? `#${channel}` : "--"}
            </div>
          </div>
        </motion.div>
      </section>

      <section className="panel">
        <h2 className="panel-title">Live Metrics</h2>
        <div className="stats-grid">
          {stats.map((stat, index) => (
            <motion.div
              className="stat-card"
              key={stat.label}
              variants={cardVariants}
              initial="hidden"
              animate="show"
              transition={{ delay: index * 0.04 }}
            >
              <div className="stat-label">{stat.label}</div>
              <div className="stat-value">{stat.value}</div>
              <div className="stat-sub">{stat.sub}</div>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="chat-layout">
        <div className="panel">
          <h2 className="panel-title">Chat Pulse</h2>
          <div className="chat-log">
            {chatLines.length === 0 ? (
              <div className="chat-line">No chat activity yet.</div>
            ) : (
              chatLines.map((line) => (
                <div key={line.id} className="chat-line">
                  <span>{line.user}:</span>
                  <span className="chat-text">{line.text}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <h2 className="panel-title">Top 5 Chatters</h2>
          <ul className="top-list">
            {topChatters.length === 0 ? (
              <li className="top-item">Waiting for chatters...</li>
            ) : (
              topChatters.map((chatter) => (
                <motion.li
                  key={chatter.user}
                  className="top-item"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div>{chatter.user}</div>
                  <span>{chatter.count} msgs</span>
                </motion.li>
              ))
            )}
          </ul>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-left">
          <div>
            Chat connection uses anonymous IRC and does not store messages.
          </div>
          <div>© {new Date().getFullYear()} Blechensen. All rights reserved.</div>
        </div>
        <div className="footer-right">
          <a
            className="support-button"
            href="https://example.com/support"
            target="_blank"
            rel="noreferrer"
          >
            Support Me
          </a>
        </div>
      </footer>
    </div>
  );
}
