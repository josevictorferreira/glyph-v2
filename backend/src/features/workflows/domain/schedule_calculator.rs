//! Cron + IANA timezone arithmetic and human descriptions for schedules
//! (Rails `Workflows::ScheduleCalculator`).

use chrono::Utc;
use chrono_tz::Tz;
use croner::Cron;
use croner::parser::CronParser;

use crate::shared::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntervalUnit {
    Minutes,
    Hours,
}

/// The recurrence builder shapes the editor offers, plus a raw cron escape hatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recurrence {
    Interval { every: i32, unit: IntervalUnit },
    Daily { hour: i32, minute: i32 },
    Weekly { weekday: i32, hour: i32, minute: i32 },
    Monthly { day: i32, hour: i32, minute: i32 },
    Cron { expression: String },
}

impl Recurrence {
    /// Mode label recorded on `WorkflowScheduleChanged`.
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Interval { .. } => "interval",
            Self::Daily { .. } => "daily",
            Self::Weekly { .. } => "weekly",
            Self::Monthly { .. } => "monthly",
            Self::Cron { .. } => "cron",
        }
    }
}

const WEEKDAYS: [&str; 7] = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/// Serializes a builder shape to cron; `None` when out of range.
pub fn cron_for(recurrence: &Recurrence) -> Option<String> {
    match recurrence {
        Recurrence::Interval { every, unit } => {
            if *every <= 0 {
                return None;
            }
            match unit {
                IntervalUnit::Minutes if *every <= 59 => Some(format!("*/{every} * * * *")),
                IntervalUnit::Hours if *every <= 23 => Some(format!("7 */{every} * * *")),
                _ => None,
            }
        }
        Recurrence::Daily { hour, minute } => Some(format!("{minute} {hour} * * *")),
        Recurrence::Weekly {
            weekday,
            hour,
            minute,
        } => Some(format!("{minute} {hour} * * {weekday}")),
        Recurrence::Monthly { day, hour, minute } => {
            (1..=31).contains(day).then(|| format!("{minute} {hour} {day} * *"))
        }
        Recurrence::Cron { expression } => {
            let expression = expression.trim();
            parse_cron(expression).map(|_| expression.to_string())
        }
    }
}

pub fn human_description_for(recurrence: &Recurrence, timezone: &str) -> String {
    match recurrence {
        Recurrence::Interval { every, unit } => {
            let unit = match unit {
                IntervalUnit::Minutes => "minute",
                IntervalUnit::Hours => "hour",
            };
            let plural = if *every == 1 { "" } else { "s" };
            format!("Every {every} {unit}{plural} ({timezone})")
        }
        Recurrence::Daily { hour, minute } => format!("Daily at {hour:02}:{minute:02} ({timezone})"),
        Recurrence::Weekly {
            weekday,
            hour,
            minute,
        } => {
            let day = WEEKDAYS
                .get(usize::try_from(*weekday).unwrap_or(usize::MAX))
                .copied()
                .unwrap_or("");
            format!("{day}s at {hour:02}:{minute:02} ({timezone})")
        }
        Recurrence::Monthly { day, hour, minute } => {
            format!("Monthly on day {day} at {hour:02}:{minute:02} ({timezone})")
        }
        Recurrence::Cron { expression } => human_description(expression.trim(), timezone),
    }
}

pub fn human_description(cron: &str, timezone: &str) -> String {
    format!("{cron} ({timezone})")
}

pub fn parse_cron(expression: &str) -> Option<Cron> {
    let expression = expression.trim();
    if expression.is_empty() {
        return None;
    }
    CronParser::new().parse(expression).ok()
}

pub fn parse_timezone(timezone: &str) -> Option<Tz> {
    timezone.parse::<Tz>().ok()
}

pub fn valid(cron: Option<&str>, timezone: Option<&str>) -> bool {
    match (cron, timezone) {
        (Some(c), Some(t)) => parse_cron(c).is_some() && parse_timezone(t).is_some(),
        _ => false,
    }
}

/// Next occurrence strictly after `from`, evaluated in `timezone` (DST-safe),
/// returned in UTC. `None` for invalid input.
pub fn next_run_at(cron: &str, timezone: &str, from: Timestamp) -> Option<Timestamp> {
    let cron = parse_cron(cron)?;
    let tz = parse_timezone(timezone)?;
    let local = from.with_timezone(&tz);
    cron.find_next_occurrence(&local, false)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Offset, TimeZone};

    fn at(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    #[test]
    fn serializes_builder_shapes() {
        use IntervalUnit::*;
        assert_eq!(cron_for(&Recurrence::Interval { every: 15, unit: Minutes }).unwrap(), "*/15 * * * *");
        assert_eq!(cron_for(&Recurrence::Interval { every: 6, unit: Hours }).unwrap(), "7 */6 * * *");
        assert_eq!(cron_for(&Recurrence::Daily { hour: 9, minute: 30 }).unwrap(), "30 9 * * *");
        assert_eq!(
            cron_for(&Recurrence::Weekly { weekday: 1, hour: 9, minute: 0 }).unwrap(),
            "0 9 * * 1"
        );
        assert_eq!(
            cron_for(&Recurrence::Monthly { day: 3, hour: 8, minute: 0 }).unwrap(),
            "0 8 3 * *"
        );
    }

    #[test]
    fn rejects_invalid_shapes() {
        use IntervalUnit::*;
        assert!(cron_for(&Recurrence::Interval { every: 0, unit: Minutes }).is_none());
        assert!(cron_for(&Recurrence::Interval { every: 90, unit: Minutes }).is_none());
        assert!(cron_for(&Recurrence::Interval { every: 24, unit: Hours }).is_none());
        assert!(cron_for(&Recurrence::Monthly { day: 40, hour: 1, minute: 1 }).is_none());
        assert!(cron_for(&Recurrence::Cron { expression: "nope".into() }).is_none());
        assert_eq!(
            cron_for(&Recurrence::Cron { expression: " 0 9 * * 1-5 ".into() }).unwrap(),
            "0 9 * * 1-5"
        );
    }

    #[test]
    fn validity() {
        assert!(valid(Some("0 9 * * *"), Some("UTC")));
        assert!(valid(Some("0 9 * * *"), Some("America/Sao_Paulo")));
        assert!(!valid(Some("nope"), Some("UTC")));
        assert!(!valid(Some("0 9 * * *"), Some("Mars/Olympus")));
        assert!(!valid(None, Some("UTC")));
    }

    #[test]
    fn next_occurrence_in_utc() {
        let next = next_run_at("0 9 * * *", "UTC", at("2026-08-04T08:00:00Z")).unwrap();
        assert_eq!(next, at("2026-08-04T09:00:00Z"));
    }

    #[test]
    fn next_occurrence_is_strictly_after() {
        let next = next_run_at("0 9 * * *", "UTC", at("2026-08-04T09:00:00Z")).unwrap();
        assert_eq!(next, at("2026-08-05T09:00:00Z"));
    }

    #[test]
    fn honours_the_timezone_offset() {
        let next = next_run_at("0 9 * * *", "America/Sao_Paulo", at("2026-08-04T11:30:00Z")).unwrap();
        assert_eq!(next, at("2026-08-04T12:00:00Z"));
    }

    #[test]
    fn handles_spring_forward_gap() {
        // 02:30 does not exist in New York on 2026-03-08.
        let next = next_run_at("30 2 * * *", "America/New_York", at("2026-03-07T12:00:00Z")).unwrap();
        let local = next.with_timezone(&chrono_tz::America::New_York);
        assert_eq!(local.offset().fix().local_minus_utc(), -4 * 3600);
    }

    #[test]
    fn handles_london_fall_back() {
        // 01:30 happens twice in London on 2026-10-25; run once.
        let from = at("2026-10-24T12:00:00Z");
        let first = next_run_at("30 1 * * *", "Europe/London", from).unwrap();
        let second = next_run_at("30 1 * * *", "Europe/London", first).unwrap();
        assert_eq!(first.date_naive().to_string(), "2026-10-25");
        assert!(second - first >= chrono::Duration::hours(23), "{first} {second}");
        let _ = chrono_tz::Europe::London.from_utc_datetime(&first.naive_utc());
    }

    #[test]
    fn invalid_input_is_none() {
        assert!(next_run_at("junk", "UTC", Utc::now()).is_none());
        assert!(next_run_at("0 9 * * *", "Not/AZone", Utc::now()).is_none());
    }

    #[test]
    fn describes_each_shape() {
        use IntervalUnit::*;
        assert_eq!(
            human_description_for(&Recurrence::Interval { every: 15, unit: Minutes }, "UTC"),
            "Every 15 minutes (UTC)"
        );
        assert_eq!(
            human_description_for(&Recurrence::Interval { every: 1, unit: Hours }, "UTC"),
            "Every 1 hour (UTC)"
        );
        assert_eq!(
            human_description_for(&Recurrence::Daily { hour: 9, minute: 5 }, "UTC"),
            "Daily at 09:05 (UTC)"
        );
        assert_eq!(
            human_description_for(&Recurrence::Weekly { weekday: 1, hour: 9, minute: 0 }, "UTC"),
            "Mondays at 09:00 (UTC)"
        );
        assert_eq!(
            human_description_for(&Recurrence::Monthly { day: 2, hour: 8, minute: 0 }, "UTC"),
            "Monthly on day 2 at 08:00 (UTC)"
        );
        assert_eq!(
            human_description_for(&Recurrence::Cron { expression: "0 9 * * 1-5".into() }, "UTC"),
            "0 9 * * 1-5 (UTC)"
        );
    }
}
