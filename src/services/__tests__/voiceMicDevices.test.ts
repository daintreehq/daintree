import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findBuiltInMic,
  isBluetoothMicLabel,
  openChosenMic,
  stripPseudoDevicePrefix,
} from "../voiceMicDevices";

describe("isBluetoothMicLabel", () => {
  it.each([
    "Greg's AirPods Pro",
    "AirPods Pro (Bluetooth)",
    "Headset (AirPods Pro Hands-Free AG Audio)",
    "Headset (WH-1000XM4 Hands-Free)",
    "Pixel Buds Pro (HSP/HFP)",
    "bluez_input.AA_BB_CC",
    "Beats Studio Buds",
  ])("treats %s as Bluetooth", (label) => {
    expect(isBluetoothMicLabel(label)).toBe(true);
  });

  it.each([
    "MacBook Pro Microphone",
    "MacBook Pro Microphone (Built-in)",
    "Microphone Array (Realtek(R) Audio)",
    "Headset Microphone (Realtek(R) Audio)",
    "Blue Yeti (046d:0ab1)",
    "Built-in Audio Analog Stereo",
    "",
  ])("does not treat %s as Bluetooth", (label) => {
    expect(isBluetoothMicLabel(label)).toBe(false);
  });

  it("is false without a label", () => {
    expect(isBluetoothMicLabel(null)).toBe(false);
    expect(isBluetoothMicLabel(undefined)).toBe(false);
  });
});

describe("stripPseudoDevicePrefix", () => {
  it("drops Chromium's default and communications prefixes", () => {
    expect(stripPseudoDevicePrefix("Default - MacBook Pro Microphone")).toBe(
      "MacBook Pro Microphone"
    );
    expect(stripPseudoDevicePrefix("Communications - Microphone Array (Realtek)")).toBe(
      "Microphone Array (Realtek)"
    );
    expect(stripPseudoDevicePrefix("AirPods Pro")).toBe("AirPods Pro");
  });
});

describe("findBuiltInMic", () => {
  it("picks the Mac's own microphone over a Bluetooth one and the default alias", () => {
    expect(
      findBuiltInMic([
        { deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { deviceId: "airpods", label: "Greg's AirPods Pro" },
        { deviceId: "builtin", label: "MacBook Pro Microphone" },
      ])
    ).toEqual({ deviceId: "builtin", label: "MacBook Pro Microphone" });
  });

  it("reads a transport suffix when the label carries one", () => {
    expect(
      findBuiltInMic([
        { deviceId: "airpods", label: "AirPods Pro (Bluetooth)" },
        { deviceId: "builtin", label: "Mac Studio Microphone (Built-in)" },
      ])
    ).toEqual({ deviceId: "builtin", label: "Mac Studio Microphone (Built-in)" });
  });

  it("prefers the Mac's own mic over its headphone-jack input", () => {
    const jack = { deviceId: "jack", label: "External Microphone (Built-in)" };
    const mac = { deviceId: "mac", label: "MacBook Air Microphone (Built-in)" };
    expect(findBuiltInMic([jack, mac])).toEqual(mac);
    expect(findBuiltInMic([jack])).toBeNull();
  });

  it("never offers a Bluetooth device, whatever else its name says", () => {
    const btArray = { deviceId: "bt", label: "Microphone Array (Bluetooth)" };
    const builtIn = { deviceId: "builtin", label: "Internal Microphone" };
    expect(findBuiltInMic([btArray])).toBeNull();
    expect(findBuiltInMic([btArray, builtIn])).toEqual(builtIn);
  });

  it("takes a Windows array mic only when it is the one array and isn't external", () => {
    const array = { deviceId: "array", label: "Microphone Array (Realtek(R) Audio)" };
    const usbArray = { deviceId: "usb", label: "Microphone Array (USB Audio Device)" };
    const internal = { deviceId: "internal", label: "Internal Microphone" };
    expect(
      findBuiltInMic([array, { deviceId: "bt", label: "Headset (Hands-Free AG Audio)" }])
    ).toEqual(array);
    expect(findBuiltInMic([array, internal])).toEqual(internal);
    expect(findBuiltInMic([usbArray])).toBeNull();
    expect(
      findBuiltInMic([array, { deviceId: "array2", label: "Microphone Array (Intel SST)" }])
    ).toBeNull();
  });

  it("returns null when no device can be told apart as built in", () => {
    expect(
      findBuiltInMic([
        { deviceId: "default", label: "Default - MacBook Pro Microphone" },
        { deviceId: "yeti", label: "Blue Yeti" },
        { deviceId: "", label: "" },
      ])
    ).toBeNull();
  });
});

describe("openChosenMic (#14850)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function micStream(label: string, deviceId: string | undefined) {
    const track = { label, stop: vi.fn(), getSettings: () => ({ deviceId }) };
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  }

  function stubGetUserMedia(...outcomes: Array<ReturnType<typeof micStream> | Error>) {
    const getUserMedia = vi.fn();
    for (const outcome of outcomes) {
      if (outcome instanceof Error) getUserMedia.mockRejectedValueOnce(outcome);
      else getUserMedia.mockResolvedValueOnce(outcome);
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    return getUserMedia;
  }

  const CHOSEN = { audio: { deviceId: { exact: "usb-mic" } }, video: false };
  const SYSTEM_DEFAULT = { audio: true, video: false };
  const DEFAULT_MIC = micStream("Default - MacBook Pro Microphone", "default");
  const error = (name: string) => new DOMException(name, name);

  it("opens the chosen mic when it is there", async () => {
    const getUserMedia = stubGetUserMedia(micStream("USB Mic", "usb-mic"));

    const mic = await openChosenMic("usb-mic");

    expect(getUserMedia.mock.calls).toEqual([[CHOSEN]]);
    expect(mic).toMatchObject({
      deviceId: "usb-mic",
      label: "USB Mic",
      substituted: false,
      chosenFailure: null,
    });
  });

  it("names the system default that opened in place of a missing mic", async () => {
    const missing = error("OverconstrainedError");
    stubGetUserMedia(missing, DEFAULT_MIC);

    const mic = await openChosenMic("usb-mic");

    expect(mic).toMatchObject({
      deviceId: "default",
      label: "MacBook Pro Microphone",
      substituted: true,
      chosenFailure: missing,
    });
  });

  it.each(["NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError"])(
    "opens the system default when the chosen mic fails with %s",
    async (name) => {
      const failure = error(name);
      const getUserMedia = stubGetUserMedia(failure, DEFAULT_MIC);

      const mic = await openChosenMic("usb-mic");

      expect(getUserMedia.mock.calls).toEqual([[CHOSEN], [SYSTEM_DEFAULT]]);
      expect(mic).toMatchObject({ substituted: true, chosenFailure: failure });
    }
  );

  it("doesn't call it a substitution when the default turns out to be the chosen mic", async () => {
    stubGetUserMedia(error("NotReadableError"), micStream("USB Mic", "usb-mic"));

    expect((await openChosenMic("usb-mic")).substituted).toBe(false);
  });

  it("calls it a substitution after a fallback when the track won't say which mic opened", async () => {
    stubGetUserMedia(error("NotReadableError"), micStream("", undefined));

    const mic = await openChosenMic("usb-mic");

    expect(mic).toMatchObject({ deviceId: null, label: null, substituted: true });
  });

  it.each([
    ["a permission denial", () => error("NotAllowedError")],
    ["a document-state error", () => error("InvalidStateError")],
    ["a programming error", () => new TypeError("bad constraints")],
  ])("doesn't fall back from %s", async (_case, make) => {
    const failure = make();
    const getUserMedia = stubGetUserMedia(failure);

    await expect(openChosenMic("usb-mic")).rejects.toBe(failure);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("rejects with the fallback's own error when the system default fails too", async () => {
    const denial = error("NotAllowedError");
    stubGetUserMedia(error("NotReadableError"), denial);

    await expect(openChosenMic("usb-mic")).rejects.toBe(denial);
  });

  it("opens nothing more once the caller has moved on", async () => {
    const failure = error("NotReadableError");
    const getUserMedia = stubGetUserMedia(failure, DEFAULT_MIC);

    // Current while the mics are listed, gone by the time the first open fails.
    const canFallBack = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    await expect(openChosenMic("usb-mic", { canFallBack })).rejects.toBe(failure);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(["", "default", "communications"])(
    "asks for the system default once when %j is chosen",
    async (deviceId) => {
      const getUserMedia = stubGetUserMedia(error("NotReadableError"));

      await expect(openChosenMic(deviceId)).rejects.toThrow();
      expect(getUserMedia.mock.calls).toEqual([[SYSTEM_DEFAULT]]);
    }
  );

  it("never calls the system default a substitution when that is the choice", async () => {
    stubGetUserMedia(micStream("MacBook Pro Microphone", "builtin"));

    expect((await openChosenMic("default")).substituted).toBe(false);
  });

  describe("finding the chosen mic again", () => {
    const RODE = "RØDE NT-USB Mini (19f7:0015)";

    function aliasStream(label: string, groupId: string | undefined) {
      const track = {
        label: `Default - ${label}`,
        stop: vi.fn(),
        getSettings: () => ({ deviceId: "default", groupId }),
      };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    }

    function stubDevices(
      outcomes: Array<{ getAudioTracks: () => unknown[] } | Error>,
      inputs: Array<{ deviceId: string; groupId?: string; label: string }>
    ) {
      const getUserMedia = vi.fn();
      for (const outcome of outcomes) {
        if (outcome instanceof Error) getUserMedia.mockRejectedValueOnce(outcome);
        else getUserMedia.mockResolvedValueOnce(outcome);
      }
      const enumerateDevices = vi
        .fn()
        .mockResolvedValue([
          ...inputs.map((input) => ({ kind: "audioinput", groupId: "", ...input })),
          { kind: "audiooutput", deviceId: "speakers", groupId: "g-out", label: "Speakers" },
        ]);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices } });
      return { getUserMedia, enumerateDevices };
    }

    it("isn't a substitution when the chosen mic opens as the default alias, by group", async () => {
      stubDevices(
        [aliasStream(RODE, "g-rode")],
        [
          { deviceId: "default", groupId: "g-rode", label: `Default - ${RODE}` },
          { deviceId: "rode", groupId: "g-rode", label: RODE },
        ]
      );

      const mic = await openChosenMic("rode", { chosenLabel: RODE });

      expect(mic).toMatchObject({ label: RODE, substituted: false, relocatedId: null });
    });

    it("is a substitution when the default alias is another device of the same name", async () => {
      stubDevices(
        [aliasStream("USB Mic", "g-b")],
        [
          { deviceId: "usb-a", groupId: "g-a", label: "USB Mic" },
          { deviceId: "usb-b", groupId: "g-b", label: "USB Mic" },
        ]
      );

      expect((await openChosenMic("usb-a", { chosenLabel: "USB Mic" })).substituted).toBe(true);
    });

    it("falls back to the name when the alias doesn't say its group", async () => {
      stubDevices([aliasStream(RODE, undefined)], [{ deviceId: "rode", label: RODE }]);

      expect((await openChosenMic("rode", { chosenLabel: RODE })).substituted).toBe(false);
    });

    it("finds a mic whose id went stale by the name saved with it", async () => {
      const { getUserMedia } = stubDevices(
        [micStream(RODE, "rode-new")],
        [
          { deviceId: "default", label: `Default - ${RODE}` },
          { deviceId: "rode-new", label: RODE },
        ]
      );

      const mic = await openChosenMic("rode-old", { chosenLabel: RODE });

      expect(getUserMedia.mock.calls).toEqual([
        [{ audio: { deviceId: { exact: "rode-new" } }, video: false }],
      ]);
      expect(mic).toMatchObject({ substituted: false, relocatedId: "rode-new" });
    });

    it("finds nothing by a name two mics share", async () => {
      const { getUserMedia } = stubDevices(
        [micStream("USB Mic", "usb-b")],
        [
          { deviceId: "usb-a", label: "USB Mic" },
          { deviceId: "usb-b", label: "USB Mic" },
        ]
      );

      const mic = await openChosenMic("usb-old", { chosenLabel: "USB Mic" });

      expect(getUserMedia.mock.calls).toEqual([[SYSTEM_DEFAULT]]);
      expect(mic).toMatchObject({ substituted: true, relocatedId: null });
    });

    it("keeps a listed id even when another mic shares its name", async () => {
      const { getUserMedia } = stubDevices(
        [micStream("USB Mic", "usb-mic")],
        [
          { deviceId: "usb-mic-2", label: "USB Mic" },
          { deviceId: "usb-mic", label: "USB Mic" },
        ]
      );

      await openChosenMic("usb-mic", { chosenLabel: "USB Mic" });

      expect(getUserMedia.mock.calls).toEqual([[CHOSEN]]);
    });

    it("still calls a same-named default a substitution after the chosen mic failed", async () => {
      stubDevices(
        [error("NotReadableError"), aliasStream("USB Mic", undefined)],
        [{ deviceId: "usb-mic", label: "USB Mic" }]
      );

      expect((await openChosenMic("usb-mic", { chosenLabel: "USB Mic" })).substituted).toBe(true);
    });

    it("opens nothing when the caller moved on while the mics were listed", async () => {
      const { getUserMedia, enumerateDevices } = stubDevices([micStream("USB Mic", "usb-mic")], []);
      let list!: (devices: unknown[]) => void;
      enumerateDevices.mockReturnValueOnce(new Promise((resolve) => (list = resolve)));
      let current = true;

      const opening = openChosenMic("usb-mic", {
        chosenLabel: "USB Mic",
        canFallBack: () => current,
      });
      current = false;
      list([{ kind: "audioinput", deviceId: "usb-mic", groupId: "", label: "USB Mic" }]);

      await expect(opening).rejects.toMatchObject({ name: "AbortError" });
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("knows the chosen mic by its group even after its first open failed", async () => {
      stubDevices(
        [error("NotReadableError"), aliasStream("USB Mic", "g-usb")],
        [{ deviceId: "usb-mic", groupId: "g-usb", label: "USB Mic" }]
      );

      expect((await openChosenMic("usb-mic", { chosenLabel: "USB Mic" })).substituted).toBe(false);
    });
  });

  describe("a chosen mic that is connected while the system default is another (#15512)", () => {
    const RODE = "RØDE NT-USB Mini (19f7:0015)";
    const AIRPODS = "Greg's AirPods Pro";

    function track(label: string, deviceId: string, groupId: string) {
      return { label, stop: vi.fn(), getSettings: () => ({ deviceId, groupId }) };
    }

    // Chromium's own choice: a soft deviceId can still bind the "default"
    // alias, which follows the system input to the AirPods; only `exact`
    // opens the device asked for, and an unknown exact id is overconstrained.
    function stubChromium(inputs: Array<{ deviceId: string; groupId: string; label: string }>) {
      const opened: string[] = [];
      const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
        const audio = constraints.audio;
        const exact =
          typeof audio === "object" && typeof audio.deviceId === "object"
            ? (audio.deviceId as ConstrainDOMStringParameters).exact
            : undefined;
        const device = exact
          ? inputs.find((input) => input.deviceId === exact)
          : inputs.find((input) => input.deviceId === "default");
        if (!device) throw new DOMException("deviceId", "OverconstrainedError");
        opened.push(device.groupId);
        const t = track(device.label, device.deviceId, device.groupId);
        return { getAudioTracks: () => [t], getTracks: () => [t] };
      });
      const enumerateDevices = vi
        .fn()
        .mockResolvedValue(inputs.map((input) => ({ kind: "audioinput", ...input })));
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices } });
      return { getUserMedia, opened };
    }

    const DEFAULT_AIRPODS = {
      deviceId: "default",
      groupId: "g-airpods",
      label: `Default - ${AIRPODS}`,
    };
    const AIRPODS_MIC = { deviceId: "airpods", groupId: "g-airpods", label: AIRPODS };
    const RODE_MIC = { deviceId: "rode", groupId: "g-rode", label: RODE };

    it("records from the chosen mic, never the AirPods the system switched to", async () => {
      const { opened } = stubChromium([DEFAULT_AIRPODS, AIRPODS_MIC, RODE_MIC]);

      const mic = await openChosenMic("rode", { chosenLabel: RODE });

      expect(opened).toEqual(["g-rode"]);
      expect(mic).toMatchObject({
        deviceId: "rode",
        label: RODE,
        substituted: false,
        chosenFailure: null,
      });
    });

    it("opens the chosen mic again under the id it has after being plugged back in", async () => {
      const { opened } = stubChromium([
        DEFAULT_AIRPODS,
        AIRPODS_MIC,
        { ...RODE_MIC, deviceId: "rode-new" },
      ]);

      const mic = await openChosenMic("rode", { chosenLabel: RODE });

      expect(opened).toEqual(["g-rode"]);
      expect(mic).toMatchObject({
        deviceId: "rode-new",
        substituted: false,
        relocatedId: "rode-new",
      });
    });

    it("opens the system default straight away when the chosen mic isn't connected", async () => {
      const { getUserMedia, opened } = stubChromium([DEFAULT_AIRPODS, AIRPODS_MIC]);

      const mic = await openChosenMic("rode", { chosenLabel: RODE });

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(opened).toEqual(["g-airpods"]);
      expect(mic).toMatchObject({ label: AIRPODS, substituted: true, chosenFailure: null });
    });
  });

  it("still hands over a stream whose track can't describe itself", async () => {
    const track = {
      label: "USB Mic",
      getSettings: () => {
        throw new Error("gone");
      },
    };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    stubGetUserMedia(stream as unknown as ReturnType<typeof micStream>);

    const mic = await openChosenMic("usb-mic");

    expect(mic.stream).toBe(stream);
    expect(mic.deviceId).toBeNull();
  });
});
