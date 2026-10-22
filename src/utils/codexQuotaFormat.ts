export function windowLabel(windowDurationMins: number): string {
  if (windowDurationMins === 10080) return "Weekly limit";
  if (windowDurationMins % 1440 === 0) return `${windowDurationMins / 1440}-day limit`;
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}-hour limit`;
  return `${windowDurationMins}-minute limit`;
}
