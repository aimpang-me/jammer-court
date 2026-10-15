// Shaped like https://services.swpc.noaa.gov/products/alerts.json as read on 2026-10-15 (product ids XM5A, BHIS, K05A,
// EF3A and A20F were seen live; message bodies trimmed). The proton item is shaped by hand: none was live that day.
export const SWPC_ALERTS = [
  { product_id: "XM5A", issue_datetime: "2026-10-14 15:09:12.000", message: "Space Weather Message Code: ALTXMF\r\nSerial Number: 1234\r\nIssue Time: 2026 Oct 14 1509 UTC\r\n\r\nALERT: X-Ray Flux exceeded M5\r\nThreshold Reached: 2026 Oct 14 1507 UTC\r\nNOAA Scale: R2 - Moderate" },
  { product_id: "BHIS", issue_datetime: "2026-10-14 16:02:40.000", message: "Space Weather Message Code: SUM10R\r\nSerial Number: 999\r\n\r\nSUMMARY: 10cm Radio Burst\r\nPeak Flux: 240 sfu" },
  { product_id: "K05A", issue_datetime: "2026-10-13 21:40:00.000", message: "Space Weather Message Code: ALTK05\r\n\r\nALERT: Geomagnetic K-index of 5\r\nNOAA Scale: G1 - Minor" },
  { product_id: "EF3A", issue_datetime: "2026-10-14 12:00:00.000", message: "Space Weather Message Code: ALTEF3\r\n\r\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1000pfu" },
  { product_id: "A20F", issue_datetime: "2026-10-12 08:00:00.000", message: "Space Weather Message Code: WATA20\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted" },
  { product_id: "PX1A", issue_datetime: "2026-10-01 01:00:00.000", message: "Space Weather Message Code: ALTPX1\r\n\r\nALERT: Proton Event 10MeV Integral Flux exceeded 10pfu" },
];
