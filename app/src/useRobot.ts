import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Command } from './protocol.ts';
import { RobotClient } from './RobotClient.ts';
import { initialState, reducer } from './store.ts';

/** Connects React state to a RobotClient. One client per URL. */
export function useRobot() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<RobotClient | null>(null);

  const connect = useCallback((url: string) => {
    clientRef.current?.disconnect();
    const client = new RobotClient({ url, dispatch });
    clientRef.current = client;
    client.connect();
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  const send = useCallback((command: Command) => {
    clientRef.current?.send(command);
  }, []);

  useEffect(() => () => clientRef.current?.disconnect(), []);

  return { state, connect, disconnect, send };
}

/** Re-renders every intervalMs so time-based UI (staleness) stays current. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
