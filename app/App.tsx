import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Command, RobotMode, TaskKind } from './src/protocol.ts';
import { newCommandId } from './src/RobotClient.ts';
import { isStale, type CommandRecord, type ConnectionStatus } from './src/store.ts';
import { useNow, useRobot } from './src/useRobot.ts';

const TASK_PRESETS: { kind: TaskKind; label: string; durationSec: number }[] = [
  { kind: 'fetch', label: 'Fetch item', durationSec: 8 },
  { kind: 'tidy', label: 'Tidy room', durationSec: 15 },
  { kind: 'patrol', label: 'Patrol', durationSec: 20 },
];

const CONNECTION_COLOR: Record<ConnectionStatus, string> = {
  connected: '#1a7f37',
  connecting: '#9a6700',
  reconnecting: '#9a6700',
  disconnected: '#6e7781',
};

export default function App() {
  return (
    <SafeAreaProvider>
      <RobotScreen />
    </SafeAreaProvider>
  );
}

function RobotScreen() {
  const { state, connect, disconnect, send } = useRobot();
  const now = useNow();
  const [url, setUrl] = useState('ws://localhost:8080');

  const robot = state.robot;
  const stale = isStale(state, now);
  const linked = state.connection !== 'disconnected';
  const mode: RobotMode | null = robot?.mode ?? null;
  const estopped = mode === 'estopped';

  const onEstop = () => {
    if (estopped && Platform.OS === 'web') {
      // Alert.alert is a no-op on react-native-web.
      if (window.confirm('Clear E-stop? Make sure the area around the robot is clear.')) {
        send({ kind: 'clear_estop' });
      }
    } else if (estopped) {
      Alert.alert('Clear E-stop?', 'Make sure the area around the robot is clear.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => send({ kind: 'clear_estop' }) },
      ]);
    } else {
      send({ kind: 'estop' });
    }
  };

  const enqueue = (p: (typeof TASK_PRESETS)[number]) =>
    send({ kind: 'enqueue_task', task: { id: newCommandId(), ...p } });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Optimus Companion</Text>
          <View style={[styles.pill, { backgroundColor: CONNECTION_COLOR[state.connection] }]}>
            <Text style={styles.pillText}>{state.connection}</Text>
          </View>
        </View>
        {state.rttMs !== null && state.connection === 'connected' && (
          <Text style={styles.muted}>Round trip {state.rttMs} ms</Text>
        )}

        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!linked}
            accessibilityLabel="Robot address"
          />
          <Button
            label={linked ? 'Disconnect' : 'Connect'}
            onPress={() => (linked ? disconnect() : connect(url.trim()))}
          />
        </View>

        {linked && stale && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {robot ? 'No live data. Showing last known state.' : 'Waiting for robot…'}
            </Text>
          </View>
        )}

        <Pressable
          onPress={onEstop}
          style={({ pressed }) => [styles.estop, estopped && styles.estopActive, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={estopped ? 'Clear emergency stop' : 'Emergency stop'}
        >
          <Text style={styles.estopText}>{estopped ? 'CLEAR E-STOP' : 'E-STOP'}</Text>
        </Pressable>

        {robot && (
          <View style={[styles.card, stale && styles.dim]}>
            <Text style={styles.cardTitle}>Status</Text>
            <Text style={styles.mode}>{robot.mode.toUpperCase()}</Text>
            <Text style={styles.label}>Battery {Math.round(robot.battery)}%</Text>
            <Bar value={robot.battery / 100} color={robot.battery <= 20 ? '#cf222e' : '#1a7f37'} />
            <Text style={styles.muted}>
              Position ({robot.position.x.toFixed(1)}, {robot.position.y.toFixed(1)}) m · heading{' '}
              {Math.round(robot.headingDeg)}°
            </Text>
            {robot.currentTask && (
              <View style={styles.section}>
                <Text style={styles.label}>Current: {robot.currentTask.label}</Text>
                <Bar value={robot.taskProgress} color="#0969da" />
                <View style={styles.row}>
                  <Button
                    small
                    label="Cancel task"
                    disabled={!linked || estopped}
                    onPress={() => send({ kind: 'cancel_task', taskId: robot.currentTask!.id })}
                  />
                </View>
              </View>
            )}
          </View>
        )}

        {robot && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Controls</Text>
            <View style={styles.row}>
              <Button label="Pause" disabled={!canPause(mode)} onPress={() => send({ kind: 'pause' })} />
              <Button label="Resume" disabled={mode !== 'paused'} onPress={() => send({ kind: 'resume' })} />
              <Button
                label="Dock"
                disabled={estopped || mode === 'docking' || mode === 'charging'}
                onPress={() => send({ kind: 'dock' })}
              />
            </View>
            <Text style={[styles.label, styles.section]}>Add task</Text>
            <View style={styles.row}>
              {TASK_PRESETS.map((p) => (
                <Button key={p.kind} label={p.label} disabled={estopped} onPress={() => enqueue(p)} />
              ))}
            </View>
          </View>
        )}

        {robot && robot.queue.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Queue ({robot.queue.length})</Text>
            {robot.queue.map((t, i) => (
              <View key={t.id} style={styles.listRow}>
                <Text style={styles.flex}>
                  {i + 1}. {t.label} · {t.durationSec}s
                </Text>
                <Button
                  small
                  label="Remove"
                  disabled={estopped}
                  onPress={() => send({ kind: 'cancel_task', taskId: t.id })}
                />
              </View>
            ))}
          </View>
        )}

        {state.commandOrder.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Commands</Text>
            {[...state.commandOrder]
              .reverse()
              .slice(0, 8)
              .map((id) => (
                <CommandRow key={id} record={state.commands[id]} />
              ))}
          </View>
        )}

        {state.log.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Robot events</Text>
            {state.log.slice(0, 12).map((e) => (
              <Text key={e.id} style={[styles.logLine, e.level !== 'info' && styles[e.level]]}>
                {new Date(e.ts).toLocaleTimeString()} {e.message}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function canPause(mode: RobotMode | null): boolean {
  return mode === 'walking' || mode === 'working' || mode === 'docking';
}

function describe(c: Command): string {
  switch (c.kind) {
    case 'enqueue_task':
      return `Add "${c.task.label}"`;
    case 'cancel_task':
      return 'Cancel task';
    case 'clear_estop':
      return 'Clear E-stop';
    case 'estop':
      return 'E-STOP';
    default:
      return c.kind[0].toUpperCase() + c.kind.slice(1);
  }
}

const STATUS_COLOR: Record<CommandRecord['status'], string> = {
  queued: '#9a6700',
  sent: '#0969da',
  acked: '#1a7f37',
  rejected: '#cf222e',
  timed_out: '#cf222e',
};

function CommandRow({ record }: { record: CommandRecord }) {
  return (
    <View style={styles.listRow}>
      <View style={styles.flex}>
        <Text>{describe(record.command)}</Text>
        {record.error && <Text style={styles.error}>{record.error}</Text>}
      </View>
      <Text style={[styles.status, { color: STATUS_COLOR[record.status] }]}>
        {record.status.replace('_', ' ')}
      </Text>
    </View>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  const pct = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` as const;
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: pct, backgroundColor: color }]} />
    </View>
  );
}

function Button(props: { label: string; onPress: () => void; disabled?: boolean; small?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      style={({ pressed }) => [
        styles.button,
        props.small && styles.buttonSmall,
        props.disabled && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f8fa' },
  container: { padding: 16, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, fontWeight: '700' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pillText: { color: '#fff', fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 180,
    borderWidth: 1,
    borderColor: '#d0d7de',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#fff',
  },
  banner: { backgroundColor: '#fff8c5', borderRadius: 8, padding: 10 },
  bannerText: { color: '#7d4e00' },
  estop: {
    backgroundColor: '#cf222e',
    borderRadius: 12,
    paddingVertical: 22,
    alignItems: 'center',
  },
  estopActive: { backgroundColor: '#24292f' },
  estopText: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: 2 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 6 },
  dim: { opacity: 0.5 },
  cardTitle: { fontWeight: '700', fontSize: 16 },
  mode: { fontSize: 28, fontWeight: '800' },
  label: { fontWeight: '600' },
  section: { marginTop: 8, gap: 6 },
  muted: { color: '#57606a' },
  barTrack: { height: 10, backgroundColor: '#eaeef2', borderRadius: 5, overflow: 'hidden' },
  barFill: { height: 10 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  flex: { flex: 1 },
  status: { fontWeight: '600' },
  error: { color: '#cf222e', fontSize: 12 },
  logLine: { fontFamily: 'Courier', fontSize: 12 },
  warn: { color: '#9a6700' },
  button: { backgroundColor: '#0969da', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  buttonSmall: { paddingVertical: 6, paddingHorizontal: 10 },
  buttonDisabled: { backgroundColor: '#8c959f' },
  buttonText: { color: '#fff', fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
