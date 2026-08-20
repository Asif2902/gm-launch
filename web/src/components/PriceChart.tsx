import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type AreaData,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { CANDLE_INTERVALS } from "@/lib/config";
import { formatChange, formatUsd } from "@/lib/format";
import { useEthPrice } from "@/lib/ethPrice";
import type { IndexedCandle } from "@/lib/types";

// Validated marks — see web/README.md. Green/red fails colourblind separation in a readable
// lightness band; this pair scores deutan ΔE 11.3.
const UP = "#0CA678";
const UP_LIGHT = "#20D9A0";
const DOWN = "#E8590C";
const DOWN_LIGHT = "#FF8341";
const BASE_BLUE = "#4C8DFF";
const GRID = "rgba(30, 34, 43, 0.75)";
const INK = "#7C8698";

type Mode = "candles" | "area";
type Unit = "usd" | "gwei";

/** Stored prices are wei per whole token. */
const toEthPerToken = (weiPerToken: string) => Number(weiPerToken) / 1e18;
const toGwei = (weiPerToken: string) => Number(weiPerToken) / 1e9;
const toEth = (wei: string) => Number(wei) / 1e18;

/** A single bucket's volume can be a small fraction of an ETH; keep it from rounding to zero. */
function formatVolume(eth: number): string {
  if (eth === 0) return "0";
  if (eth >= 1) return eth.toFixed(3);
  if (eth >= 0.001) return eth.toFixed(5);
  return eth.toExponential(2);
}

/**
 * How much of the series to show by default.
 *
 * `fitContent()` is wrong at both ends. With three candles it stretches them into slabs that fill
 * the pane; with five hundred it crushes them into a smear. Holding the window between these
 * bounds means a bar is always roughly bar-sized, and a young token reads as "barely any trades
 * yet" rather than as a giant green block.
 */
const MIN_VISIBLE_BARS = 90;
const MAX_VISIBLE_BARS = 180;

interface HoverState {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function PriceChart({ address, currentPrice }: { address: string; currentPrice?: string }) {
  const [interval, setInterval] = useState<number>(300);
  const [mode, setMode] = useState<Mode>("candles");
  const [unit, setUnit] = useState<Unit>("usd");
  const [hover, setHover] = useState<HoverState | null>(null);

  const { usd: ethUsd } = useEthPrice();

  // USD mode needs a rate; without one the chart falls back to gwei, which is always available.
  const usd = unit === "usd" && ethUsd !== null;

  /**
   * The plotted value is the token's **unit price** — what one token costs.
   *
   * A fresh curve is around $0.0000015, which no ordinary axis renders usefully. Rather than
   * substituting a different quantity (valuation) to dodge that, the axis keeps the real price
   * and a custom formatter collapses the leading zeros: `$0.0₅14`. The number on the axis is the
   * number you pay.
   */
  const toDisplay = useMemo(
    () =>
      usd
        ? (weiPerToken: string) => toEthPerToken(weiPerToken) * ethUsd!
        : (weiPerToken: string) => toGwei(weiPerToken),
    [usd, ethUsd],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  // Only auto-position the viewport when the series identity changes, never on a live tick —
  // otherwise the chart yanks itself back every few seconds while you are panning it.
  const viewportKey = useRef<string>("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["candles", address, interval],
    queryFn: () => api.candles(address, interval, 500),
    refetchInterval: 6_000,
  });

  const candles = useMemo(() => data?.candles ?? [], [data]);

  // --- create the chart once ------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: INK,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: GRID, style: LineStyle.Dotted },
        horzLines: { color: GRID, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: "rgba(30, 34, 43, 0.9)",
        scaleMargins: { top: 0.08, bottom: 0.02 },
        // Sub-cent prices need the width; the default clips the subscript notation.
        minimumWidth: 92,
      },
      timeScale: {
        borderColor: "rgba(30, 34, 43, 0.9)",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        minBarSpacing: 0.5,
        // Breathing room on the right so the newest candle isn't flush against the axis.
        rightOffset: 6,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(76, 141, 255, 0.55)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#0052FF",
        },
        horzLine: {
          color: "rgba(76, 141, 255, 0.55)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#0052FF",
        },
      },
      // Everything a trader expects from a chart: drag the plot to pan, wheel to zoom, drag
      // either axis to rescale it, double-click an axis to snap back to auto.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      height: 420,
      width: container.clientWidth,
    });

    /**
     * The price scale autoscales to the data range rather than to zero.
     *
     * An earlier version pinned the minimum at zero to stop the axis labelling negative values.
     * That fixed the labels and ruined the chart: a curve trading between $0.0000010 and
     * $0.0000014 was squashed into the top few percent of the pane, so no price action was
     * visible at all. Negative labels were really a symptom of an oversized bottom margin, which
     * is now 2%, so the data range can speak for itself — as it does on any trading chart.
     */

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP_LIGHT,
      borderDownColor: DOWN_LIGHT,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });

    const areaSeries = chart.addAreaSeries({
      lineColor: BASE_BLUE,
      lineWidth: 2,
      topColor: "rgba(0, 82, 255, 0.32)",
      bottomColor: "rgba(0, 82, 255, 0.01)",
      crosshairMarkerBorderColor: "#0052FF",
      crosshairMarkerBackgroundColor: "#FFFFFF",
      visible: false,
    });

    // Volume lives in its own scale confined to the bottom band — a magnitude ribbon under the
    // price line, not a second labelled y-axis inviting comparison against it.
    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: "rgba(76, 141, 255, 0.35)",
      // `localization.priceFormatter` applies to every series, so the volume series would
      // otherwise stamp an ETH figure onto the price axis wearing a dollar sign. The ribbon
      // needs no value marker at all — the readout row above reports volume explicitly.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.86, bottom: 0 },
      visible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setHover(null);
        return;
      }
      const candle = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      const volume = param.seriesData.get(volumeSeries) as HistogramData | undefined;
      if (!candle) {
        setHover(null);
        return;
      }
      setHover({
        time: Number(param.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volume?.value ?? 0,
      });
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    areaRef.current = areaSeries;
    volumeRef.current = volumeSeries;

    const observer = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      areaRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  // --- axis formatting follows the unit --------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleRef.current || !areaRef.current) return;

    // The custom formatter is what lets the real price stay on the axis: it renders 0.0000014 as
    // "$0.0₅14" instead of "0.00". `minMove` still has to be small enough for the scale to
    // generate distinct ticks at that magnitude, or every gridline collapses onto one value.
    chart.applyOptions({
      localization: {
        priceFormatter: usd
          ? (value: number) => formatUsd(value, { compact: false })
          : (value: number) => value.toFixed(4),
      },
    });

    const priceFormat = usd
      ? { type: "price" as const, precision: 12, minMove: 0.000000000001 }
      : { type: "price" as const, precision: 4, minMove: 0.0001 };

    candleRef.current.applyOptions({ priceFormat });
    areaRef.current.applyOptions({ priceFormat });
  }, [usd]);

  // --- feed data --------------------------------------------------------------------------------
  useEffect(() => {
    if (!candleRef.current || !areaRef.current || !volumeRef.current) return;

    const candleData: CandlestickData[] = candles.map((candle: IndexedCandle) => ({
      time: Number(candle.bucket_start) as UTCTimestamp,
      open: toDisplay(candle.open),
      high: toDisplay(candle.high),
      low: toDisplay(candle.low),
      close: toDisplay(candle.close),
    }));

    const areaData: AreaData[] = candles.map((candle: IndexedCandle) => ({
      time: Number(candle.bucket_start) as UTCTimestamp,
      value: toDisplay(candle.close),
    }));

    const volumeData: HistogramData[] = candles.map((candle: IndexedCandle) => ({
      time: Number(candle.bucket_start) as UTCTimestamp,
      value: toEth(candle.volume_eth),
      color:
        toDisplay(candle.close) >= toDisplay(candle.open)
          ? "rgba(12, 166, 120, 0.45)"
          : "rgba(232, 89, 12, 0.45)",
    }));

    candleRef.current.setData(candleData);
    areaRef.current.setData(areaData);
    volumeRef.current.setData(volumeData);

    // Reposition only when the series changes identity (token or interval), so a live tick never
    // steals the viewport from someone who has panned or zoomed.
    const key = `${address}-${interval}`;
    if (candleData.length > 0 && viewportKey.current !== key) {
      viewportKey.current = key;
      const count = candleData.length;
      const visible = Math.min(Math.max(count, MIN_VISIBLE_BARS), MAX_VISIBLE_BARS);
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: count - visible,
        to: count + 6,
      });
    }
  }, [candles, toDisplay, address, interval]);

  // --- mode toggle -------------------------------------------------------------------------------
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: mode === "candles" });
    areaRef.current?.applyOptions({ visible: mode === "area" });
  }, [mode]);

  const latest = candles.length > 0 ? candles[candles.length - 1] : null;
  const first = candles.length > 0 ? candles[0] : null;

  // `hover` comes from the series so it is already in display units; the fallback reads the raw
  // candle and must go through the same conversion.
  const readout =
    hover ??
    (latest
      ? {
          time: Number(latest.bucket_start),
          open: toDisplay(latest.open),
          high: toDisplay(latest.high),
          low: toDisplay(latest.low),
          close: toDisplay(latest.close),
          volume: toEth(latest.volume_eth),
        }
      : null);

  // A ratio, so it is the same number in either unit.
  const periodChange =
    first && latest ? (toGwei(latest.close) / toGwei(first.open) - 1) * 100 : null;

  // Below what the label can resolve, so "+0.0%" is never shown with a direction attached to it.
  const flat = periodChange !== null && Math.abs(periodChange) < 0.05;

  const rising = readout ? readout.close >= readout.open : true;
  const showValue = (value: number) => (usd ? formatUsd(value, { compact: false }) : value.toFixed(4));

  return (
    <div className="card overflow-hidden">
      {/* Controls in one row above the plot. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line px-4 py-3">
        <div>
          <div className="label">Price</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="tnum text-2xl font-black tracking-tight">
              {currentPrice ? showValue(toDisplay(currentPrice)) : "—"}
            </span>
            {!usd && <span className="text-xs font-medium text-dim">gwei</span>}
            {periodChange !== null && (
              // Scoped to the loaded range, not a fixed 24h window — say so, so it can't be
              // misread as a daily change. A flat range gets neither arrow nor a direction
              // colour: an up arrow over "+0.0%" reads as a rendering fault, and here it is a
              // real state — a curve bought up and sold back out ends exactly where it started.
              <span
                className={`tnum text-sm font-bold ${
                  flat ? "text-muted" : periodChange > 0 ? "text-up-light" : "text-down-light"
                }`}
                title={
                  flat
                    ? "Unchanged across the loaded chart range"
                    : "Change across the loaded chart range"
                }
              >
                {flat ? "" : periodChange > 0 ? "▲ " : "▼ "}
                {flat ? "0%" : formatChange(Math.abs(periodChange))}
                <span className="ml-1 text-[10px] font-medium text-dim">range</span>
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="segmented">
            {(["usd", "gwei"] as Unit[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setUnit(option)}
                data-active={unit === option}
                disabled={option === "usd" && ethUsd === null}
                className="segmented-item disabled:opacity-40"
                title={
                  option === "usd" ? "Price in US dollars" : "Price in gwei per token"
                }
              >
                {option === "usd" ? "USD" : "gwei"}
              </button>
            ))}
          </div>

          <div className="segmented">
            {(["candles", "area"] as Mode[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                data-active={mode === option}
                className="segmented-item capitalize"
              >
                {option}
              </button>
            ))}
          </div>

          <div className="segmented scrollbar-none overflow-x-auto">
            {CANDLE_INTERVALS.map((option) => (
              <button
                key={option.seconds}
                type="button"
                onClick={() => setInterval(option.seconds)}
                data-active={interval === option.seconds}
                className="segmented-item"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Hover readout — the legend for a single-series chart, so no legend box is needed. */}
      {readout && (
        <div className="tnum flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-elevated/30 px-4 py-2 text-[11px]">
          <span className="text-dim">
            {new Date(readout.time * 1000).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <Readout label="O" value={showValue(readout.open)} />
          <Readout label="H" value={showValue(readout.high)} />
          <Readout label="L" value={showValue(readout.low)} />
          <Readout label="C" value={showValue(readout.close)} tone={rising ? "up" : "down"} />
          <span className="ml-auto text-dim">
            Vol <span className="font-semibold text-white">{formatVolume(readout.volume)} ETH</span>
          </span>
        </div>
      )}

      <div className="relative">
        <div ref={containerRef} className="h-[420px] w-full" />

        {(isLoading || isError || candles.length === 0) && (
          <div className="absolute inset-0 grid place-items-center bg-surface/70 text-sm text-muted backdrop-blur-sm">
            {isLoading ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin-slow rounded-full border-2 border-brand border-t-transparent" />
                Loading chart…
              </span>
            ) : isError ? (
              "Chart unavailable"
            ) : (
              "No trades yet — the chart starts with the first buy."
            )}
          </div>
        )}

      </div>
    </div>
  );
}

function Readout({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <span className="text-dim">
      {label}{" "}
      <span
        className={
          tone === "up" ? "text-up-light" : tone === "down" ? "text-down-light" : "text-white"
        }
      >
        {value}
      </span>
    </span>
  );
}
