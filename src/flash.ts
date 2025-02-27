import { connect, ESPLoader, Logger } from "esp-web-flasher";
import { Build, FlashError, FlashState, Manifest, State } from "./const";
import { fireEvent, getChipFamilyName, sleep } from "./util";

export const flash = async (
  eventTarget: EventTarget,
  logger: Logger,
  manifestPath: string,
  eraseFirst: boolean
) => {
  let manifest: Manifest;
  let build: Build | undefined;
  let chipFamily: "ESP32" | "ESP8266" | "ESP32-S2" | "Unknown Chip";

  const fireStateEvent = (stateUpdate: FlashState) => {
    fireEvent(eventTarget, "state-changed", {
      ...stateUpdate,
      manifest,
      build,
      chipFamily,
    });
  };

  const manifestURL = new URL(manifestPath, location.toString()).toString();
  const manifestProm = fetch(manifestURL).then(
    (resp): Promise<Manifest> => resp.json()
  );

  let esploader: ESPLoader | undefined;

  try {
    esploader = await connect(logger);
  } catch (err) {
    // User pressed cancel on web serial
    return;
  }

  // For debugging
  (window as any).esploader = esploader;

  fireStateEvent({
    state: State.INITIALIZING,
    message: "Đang cài đặt...",
    details: { done: false },
  });

  try {
    await esploader.initialize();
  } catch (err) {
    logger.error(err);
    if (esploader.connected) {
      fireStateEvent({
        state: State.ERROR,
        message:
          "Không thể khởi tạo. Thử reset thiết bị và giữ nút FLASH hoặc nút BOOT khi chọn cổng COM.",
        details: { error: FlashError.FAILED_INITIALIZING, details: err },
      });
      await esploader.disconnect();
    }
    return;
  }

  chipFamily = getChipFamilyName(esploader);

  fireStateEvent({
    state: State.INITIALIZING,
    message: `Đã khởi tạo cài đặt cho Chip ${chipFamily}`,
    details: { done: true },
  });
  fireStateEvent({
    state: State.MANIFEST,
    message: "Đang tìm Firmware...",
    details: { done: false },
  });

  try {
    manifest = await manifestProm;
  } catch (err) {
    fireStateEvent({
      state: State.ERROR,
      message: `Không tìm thấy phần mềm phù hợp: ${err.message}`,
      details: { error: FlashError.FAILED_MANIFEST_FETCH, details: err },
    });
    await esploader.disconnect();
    return;
  }

  build = manifest.builds.find((b) => b.chipFamily === chipFamily);

  fireStateEvent({
    state: State.MANIFEST,
    message: `Tìm thấy yêu cầu ${manifest.name}`,
    details: { done: true },
  });

  if (!build) {
    fireStateEvent({
      state: State.ERROR,
      message: `Bo mạch ${chipFamily} không được hỗ trợ.`,
      details: { error: FlashError.NOT_SUPPORTED, details: chipFamily },
    });
    await esploader.disconnect();
    return;
  }

  fireStateEvent({
    state: State.PREPARING,
    message: "Đang chuẩn bị cài đặt...",
    details: { done: false },
  });

  const filePromises = build.parts.map(async (part) => {
    const url = new URL(part.path, manifestURL).toString();
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `Đang tải firmware ${part.path} gặp lỗi: ${resp.status}`
      );
    }
    return resp.arrayBuffer();
  });

  // Run the stub while we wait for files to download
  const espStub = await esploader.runStub();

  const files: ArrayBuffer[] = [];
  let totalSize = 0;

  for (const prom of filePromises) {
    try {
      const data = await prom;
      files.push(data);
      totalSize += data.byteLength;
    } catch (err) {
      fireStateEvent({
        state: State.ERROR,
        message: err,
        details: { error: FlashError.FAILED_FIRMWARE_DOWNLOAD, details: err },
      });
      await esploader.disconnect();
      return;
    }
  }

  fireStateEvent({
    state: State.PREPARING,
    message: "Đang chuẩn bị cài đặt",
    details: { done: true },
  });

  if (eraseFirst) {
    fireStateEvent({
      state: State.ERASING,
      message: "Đang xóa...",
      details: { done: false },
    });
    await espStub.eraseFlash();
    fireStateEvent({
      state: State.ERASING,
      message: "Đã xóa thiết bị",
      details: { done: true },
    });
  }

  let lastPct = 0;

  fireStateEvent({
    state: State.WRITING,
    message: `Quá trình ghi: ${lastPct}%`,
    details: {
      bytesTotal: totalSize,
      bytesWritten: 0,
      percentage: lastPct,
    },
  });

  let totalWritten = 0;

  for (const part of build.parts) {
    const file = files.shift()!;
    try {
      await espStub.flashData(
        file,
        (bytesWritten: number) => {
          const newPct = Math.floor(
            ((totalWritten + bytesWritten) / totalSize) * 100
          );
          if (newPct === lastPct) {
            return;
          }
          lastPct = newPct;
          fireStateEvent({
            state: State.WRITING,
            message: `Tiến trình ghi: ${newPct}%`,
            details: {
              bytesTotal: totalSize,
              bytesWritten: totalWritten + bytesWritten,
              percentage: newPct,
            },
          });
        },
        part.offset,
        true
      );
    } catch (err) {
      fireStateEvent({
        state: State.ERROR,
        message: err,
        details: { error: FlashError.WRITE_FAILED, details: err },
      });
      await esploader.disconnect();
      return;
    }
    totalWritten += file.byteLength;
  }

  fireStateEvent({
    state: State.WRITING,
    message: "Flash thành công",
    details: {
      bytesTotal: totalSize,
      bytesWritten: totalWritten,
      percentage: 100,
    },
  });

  await sleep(100);
  await esploader.hardReset();
  await esploader.disconnect();

  fireStateEvent({
    state: State.FINISHED,
    message: "Tuyệt vời. Đã hoàn thành!",
  });
};
