import { HomeAssistant } from 'custom-card-helpers';
import add from 'date-fns/add';
import sub from 'date-fns/sub';
import { DataSet } from 'vis-data';
import { IdType, TimelineItem, TimelineWindow } from 'vis-timeline/esnext';
import { CameraConfig, ClipsOrSnapshotsOrAll, RecordingSegment } from '../types';
import { CameraManager } from '../camera/manager';
import { EventQuery } from '../camera/types';
import { capEndDate, convertRangeToCacheFriendlyTimes } from '../camera/util';
import { EventMediaQueries } from "../view/media-queries";
import { ViewMedia } from '../view/media';
import { compressRanges, ExpiringMemoryRangeSet, MemoryRangeSet } from '../camera/range';
import { errorToConsole, ModifyInterface } from './basic.js';

// Allow timeline freshness to be at least this number of seconds out of date
// (caching times in the data-engine may increase the effective delay).
const TIMELINE_FRESHNESS_TOLERANCE_SECONDS = 30;

// Number of seconds gap allowable in order to consider two recording segments
// to be consecutive. Some low performance cameras have trouble and without a
// generous allowance here the timeline may be littered with individual segments
// instead of clean recording blocks.
const TIMELINE_RECORDING_SEGMENT_CONSECUTIVE_TOLERANCE_SECONDS = 60;

export interface FrigateCardTimelineItem extends TimelineItem {
  // Use numbers to avoid significant volumes of Date object construction (for
  // high-quantity recording segments).
  start: number;
  end?: number;
  media?: ViewMedia;
}

export class TimelineDataSource {
  protected _cameraManager: CameraManager;
  protected _dataset: DataSet<FrigateCardTimelineItem> = new DataSet();

  // The ranges in which recordings have been calculated and added for.
  // Calculating recordings is a very expensive process since it is based on
  // segments (not just the fetch is expensive, but the JS to dedup and turn the
  // high-N segments into a smaller number of consecutive recording blocks).
  protected _recordingRanges = new MemoryRangeSet();

  // Cache event ranges since re-adding the same events is a timeline
  // performance killer (even if the request results are cached).
  protected _eventRanges = new ExpiringMemoryRangeSet();

  protected _cameraIDs: Set<string>;
  protected _mediaType: ClipsOrSnapshotsOrAll;

  constructor(
    cameraManager: CameraManager,
    cameraIDs: Set<string>,
    media: ClipsOrSnapshotsOrAll,
  ) {
    this._cameraManager = cameraManager;
    this._cameraIDs = cameraIDs;
    this._mediaType = media;
  }

  get dataset(): DataSet<FrigateCardTimelineItem> {
    return this._dataset;
  }

  public clearEvents(): void {
    this._eventRanges.clear();
    this._dataset.remove(
      this._dataset.get({
        filter: (item) => item.type !== 'background',
      }),
    );
  }

  public rewriteEvent(id: IdType): void {
    // Hack: For timeline uses of the event dataset clustering may not update
    // unless the dataset changes, artifically update the dataset to ensure the
    // newly selected item cannot be included in a cluster.

    // Hack2: Cannot use `updateOnly` here, as vis-data loses the object
    // prototype, see: https://github.com/visjs/vis-data/issues/997 . Instead,
    // remove then add.
    const item = this._dataset.get(id);
    if (item) {
      this._dataset.remove(id);
      this._dataset.add(item);
    }
  }

  public async refresh(
    hass: HomeAssistant,
    cameras: Map<string, CameraConfig>,
    window: TimelineWindow,
  ): Promise<void> {
    try {
      await Promise.all([
        this._refreshEvents(hass, cameras, window),
        this._refreshRecordings(hass, window),
      ]);
    } catch (e) {
      errorToConsole(e as Error);

      // Intentionally ignore errors here, since it is likely the user will
      // change the range again and a subsequent call may work. To do otherwise
      // would be jarring to the timeline experience in the case of transient
      // errors from the backend.
    }
  }

  public getCacheFriendlyEventWindow(window: TimelineWindow): TimelineWindow {
    return convertRangeToCacheFriendlyTimes(window, {
      endCap: true,
    });
  }

  public getTimelineEventQueries(window: TimelineWindow): EventQuery[] {
    return this._cameraManager.generateDefaultEventQueries(this._cameraIDs, {
      start: window.start,
      end: window.end,
      ...(this._mediaType === 'clips' && { hasClip: true }),
      ...(this._mediaType === 'snapshots' && { hasSnapshot: true }),
    });
  }

  protected async _refreshEvents(
    hass: HomeAssistant,
    cameras: Map<string, CameraConfig>,
    window: TimelineWindow,
  ): Promise<void> {
    if (
      this._eventRanges.hasCoverage({
        start: window.start,
        end: sub(capEndDate(window.end), {
          seconds: TIMELINE_FRESHNESS_TOLERANCE_SECONDS,
        }),
      })
    ) {
      return;
    }

    const cacheFriendlyWindow = this.getCacheFriendlyEventWindow(window);
    const query = new EventMediaQueries(
      this.getTimelineEventQueries(cacheFriendlyWindow),
    );

    const results = await this._cameraManager.executeMediaQuery(hass, query);
    for (const media of results?.getResults() ?? []) {
      const endTime = media.getEndTime();
      const startTime = media.getStartTime();
      const id = media.getID(cameras.get(media.getCameraID()));
      if (id && startTime) {
        this._dataset.update({
          id: id,
          group: media.getCameraID(),
          content: '',
          media: media,
          start: startTime.getTime(),
          type: endTime ? 'range' : 'point',
          ...(endTime && { end: endTime.getTime() }),
        });
      }
    }

    this._eventRanges.add({
      ...cacheFriendlyWindow,
      expires: add(new Date(), { seconds: TIMELINE_FRESHNESS_TOLERANCE_SECONDS }),
    });
  }

  protected async _refreshRecordings(
    hass: HomeAssistant,
    window: TimelineWindow,
  ): Promise<void> {
    type FrigateCardTimelineItemWithEnd = ModifyInterface<
      FrigateCardTimelineItem,
      { end: number }
    >;

    const convertSegmentToRecording = (
      cameraID: string,
      segment: RecordingSegment,
    ): FrigateCardTimelineItemWithEnd => {
      return {
        id: `recording-${cameraID}-${segment.id}`,
        group: cameraID,
        start: segment.start_time * 1000,
        end: segment.end_time * 1000,
        content: '',
        type: 'background',
      };
    };

    const getExistingRecordingsForCameraID = (
      cameraID: string,
    ): FrigateCardTimelineItemWithEnd[] => {
      return this._dataset.get({
        filter: (item) =>
          item.type == 'background' && item.group === cameraID && item.end !== undefined,
      }) as FrigateCardTimelineItemWithEnd[];
    };

    const deleteRecordingsForCameraID = (cameraID: string): void => {
      this._dataset.remove(
        this._dataset.get({
          filter: (item) => item.type === 'background' && item.group === cameraID,
        }),
      );
    };

    const addRecordings = (recordings: FrigateCardTimelineItemWithEnd[]): void => {
      this._dataset.add(recordings);
    };

    // Calculate an end date that's slightly short of the current time to allow
    // for caching up to the freshness tolerance.
    if (
      this._recordingRanges.hasCoverage({
        start: window.start,
        end: sub(capEndDate(window.end), {
          seconds: TIMELINE_FRESHNESS_TOLERANCE_SECONDS,
        }),
      })
    ) {
      return;
    }

    const cacheFriendlyWindow = convertRangeToCacheFriendlyTimes(window, {
      endCap: true,
    });

    const queries = this._cameraManager.generateDefaultRecordingSegmentsQueries(
      this._cameraIDs,
      {
        start: cacheFriendlyWindow.start,
        end: cacheFriendlyWindow.end,
      },
    );

    const results = await this._cameraManager.getRecordingSegments(hass, queries);

    const newSegments: Map<string, RecordingSegment[]> = new Map();
    for (const [query, result] of results) {
      let destination: RecordingSegment[] | undefined = newSegments.get(query.cameraID);
      if (!destination) {
        destination = [];
        newSegments.set(query.cameraID, destination);
      }
      result.segments.forEach((segment) => destination?.push(segment));
    }

    for (const [cameraID, segments] of newSegments.entries()) {
      const existingRecordings = getExistingRecordingsForCameraID(cameraID);
      const mergedRecordings = existingRecordings.concat(
        segments.map((segment) => convertSegmentToRecording(cameraID, segment)),
      );
      const compressedRecordings = compressRanges(
        mergedRecordings,
        TIMELINE_RECORDING_SEGMENT_CONSECUTIVE_TOLERANCE_SECONDS,
      ) as FrigateCardTimelineItemWithEnd[];

      deleteRecordingsForCameraID(cameraID);
      addRecordings(compressedRecordings);
    }

    this._recordingRanges.add({
      start: cacheFriendlyWindow.start,
      end: cacheFriendlyWindow.end,
    });
  }
}
