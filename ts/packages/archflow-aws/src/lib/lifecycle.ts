import { Task } from '@aws-sdk/client-ecs';
import { LifecycleTimestamps } from './model';

function iso(value?: Date): string | undefined {
    return value?.toISOString();
}

export function lifecycleFromTask(task: Task, submittedAt: string): LifecycleTimestamps {
    return {
        submittedAt,
        createdAt: iso(task.createdAt),
        pullStartedAt: iso(task.pullStartedAt),
        pullStoppedAt: iso(task.pullStoppedAt),
        startedAt: iso(task.startedAt),
        executionStoppedAt: iso(task.executionStoppedAt),
        stoppedAt: iso(task.stoppedAt),
    };
}

export interface ParsedApplicationLog {
    applicationStartedAt?: string;
    applicationEndedAt?: string;
    actualArchitecture?: string;
    ffmpegVersion?: string;
}

export function parseApplicationMarkers(messages: string[]): ParsedApplicationLog {
    const parsed: ParsedApplicationLog = {};
    for (const message of messages) {
        const jsonStart = message.indexOf('{');
        if (jsonStart < 0) {
            continue;
        }
        try {
            const marker = JSON.parse(message.slice(jsonStart)) as Record<string, unknown>;
            if (marker.event === 'archflow_application_start' && typeof marker.timestamp === 'string') {
                parsed.applicationStartedAt = marker.timestamp;
            }
            if (marker.event === 'archflow_application_end' && typeof marker.timestamp === 'string') {
                parsed.applicationEndedAt = marker.timestamp;
            }
            if (marker.event === 'archflow_runtime' && typeof marker.architecture === 'string') {
                parsed.actualArchitecture = marker.architecture;
                if (typeof marker.ffmpegVersion === 'string') {
                    parsed.ffmpegVersion = marker.ffmpegVersion;
                }
            }
        } catch {
            // Ordinary FFmpeg output is intentionally ignored by the marker parser.
        }
    }
    return parsed;
}
