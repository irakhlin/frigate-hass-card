import { describe, expect, it, vi } from 'vitest';
import {
  capEndDate,
  convertRangeToCacheFriendlyTimes,
  getCameraEntityFromConfig,
  getDefaultGo2RTCEndpoint,
  sortMedia,
} from '../../src/camera-manager/utils.js';
import { CameraConfig, cameraConfigSchema } from '../../src/config/types.js';
import { TestViewMedia, createCameraConfig } from '../test-utils.js';

describe('convertRangeToCacheFriendlyTimes', () => {
  it('should return cache friendly within hour range', () => {
    expect(
      convertRangeToCacheFriendlyTimes({
        start: new Date('2023-04-29T14:01:02'),
        end: new Date('2023-04-29T14:11:03'),
      }),
    ).toEqual({
      start: new Date('2023-04-29T14:00:00'),
      end: new Date('2023-04-29T14:59:59.999'),
    });
  });

  it('should return cache friendly within day range', () => {
    expect(
      convertRangeToCacheFriendlyTimes({
        start: new Date('2023-04-29T14:01:02'),
        end: new Date('2023-04-29T15:11:03'),
      }),
    ).toEqual({
      start: new Date('2023-04-29T00:00:00'),
      end: new Date('2023-04-29T23:59:59.999'),
    });
  });

  it('should cap end date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-04-29T14:25'));
    expect(
      convertRangeToCacheFriendlyTimes(
        {
          start: new Date('2023-04-29T14:01:02'),
          end: new Date('2023-04-29T14:11:03'),
        },
        { endCap: true },
      ),
    ).toEqual({
      start: new Date('2023-04-29T14:00:00'),
      end: new Date('2023-04-29T14:25:59.999'),
    });
    vi.useRealTimers();
  });
});

describe('capEndDate', () => {
  it('should cap end date', () => {
    const fakeNow = new Date('2023-04-29T14:25');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    expect(capEndDate(new Date('2023-04-29T15:02'))).toEqual(fakeNow);

    vi.useRealTimers();
  });

  it('should not cap end date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-04-29T14:25'));

    const testDate = new Date('2023-04-29T14:24');
    expect(capEndDate(testDate)).toEqual(testDate);

    vi.useRealTimers();
  });
});

describe('sortMedia', () => {
  const media_1 = new TestViewMedia({
    id: 'id-1',
    startTime: new Date('2023-04-29T14:25'),
    cameraID: 'camera-1',
  });
  const media_2 = new TestViewMedia({
    id: 'id-2',
    startTime: new Date('2023-04-29T14:26'),
    cameraID: 'camera-1',
  });
  const media_3_dup_id = new TestViewMedia({
    id: 'id-2',
    startTime: new Date('2023-04-29T14:26'),
    cameraID: 'camera-1',
  });
  const media_4_no_id = new TestViewMedia({
    id: null,
    startTime: new Date('2023-04-29T14:27'),
    cameraID: 'camera-1',
  });

  it('should sort sorted media', () => {
    const media = [media_1, media_2];
    expect(sortMedia(media)).toEqual(media);
  });
  it('should sort unsorted media', () => {
    expect(sortMedia([media_2, media_1])).toEqual([media_1, media_2]);
  });
  it('should remove duplicate id', () => {
    expect(sortMedia([media_1, media_2, media_3_dup_id])).toEqual([media_1, media_2]);
  });
  it('should sort by id when time not available', () => {
    expect(
      sortMedia([
        new TestViewMedia({ id: 'snake' }),
        new TestViewMedia({ id: 'zebra' }),
        new TestViewMedia({ id: 'aardvark' }),
      ]),
    ).toEqual([
      new TestViewMedia({ id: 'aardvark' }),
      new TestViewMedia({ id: 'snake' }),
      new TestViewMedia({ id: 'zebra' }),
    ]);
  });
  it('should remove de-duplicate by object if no id', () => {
    expect(sortMedia([media_1, media_2, media_4_no_id, media_4_no_id])).toEqual([
      media_1,
      media_2,
      media_4_no_id,
    ]);
  });
});

describe('getCameraEntityFromConfig', () => {
  const createCameraConfig = (config: Partial<CameraConfig>): CameraConfig => {
    return cameraConfigSchema.parse(config);
  };

  it('should get camera_entity', () => {
    expect(getCameraEntityFromConfig(createCameraConfig({ camera_entity: 'foo' }))).toBe(
      'foo',
    );
  });
  it('should get camera_entity from webrtc_card config', () => {
    expect(
      getCameraEntityFromConfig(createCameraConfig({ webrtc_card: { entity: 'bar' } })),
    ).toBe('bar');
  });
  it('should get no camera_entity', () => {
    expect(getCameraEntityFromConfig(createCameraConfig({}))).toBeNull();
  });
});

describe('getDefaultGo2RTCEndpoint', () => {
  it('with local configuration', () => {
    expect(
      getDefaultGo2RTCEndpoint(
        createCameraConfig({
          go2rtc: {
            stream: 'stream',
            url: '/local/path',
          },
        }),
      ),
    ).toEqual({
      endpoint: '/local/path/api/ws?src=stream',
      sign: true,
    });
  });

  it('with remote configuration', () => {
    expect(
      getDefaultGo2RTCEndpoint(
        createCameraConfig({
          go2rtc: {
            stream: 'stream',
            url: 'https://my-custom-go2rtc',
          },
        }),
      ),
    ).toEqual({
      endpoint: 'https://my-custom-go2rtc/api/ws?src=stream',
      sign: false,
    });
  });

  it('without configuration', () => {
    expect(getDefaultGo2RTCEndpoint(createCameraConfig())).toBeNull();
  });
});
