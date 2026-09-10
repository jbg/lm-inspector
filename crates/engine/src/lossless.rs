//! 64-bit integers cross the IPC boundary as decimal strings so the webview
//! never rounds them through f64. eredu record payloads are forwarded as
//! pre-serialized JSON strings and re-parsed losslessly on the frontend; the
//! helpers here cover our own DTO fields.

/// Serialize a `u64` as a decimal string and accept either form on input.
pub mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Num(u64),
            Str(String),
        }
        match Repr::deserialize(deserializer)? {
            Repr::Num(n) => Ok(n),
            Repr::Str(s) => s.parse().map_err(serde::de::Error::custom),
        }
    }
}

/// Serialize an `Option<u64>` as an optional decimal string.
pub mod opt_u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => serializer.collect_str(v),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Num(u64),
            Str(String),
        }
        let opt: Option<Repr> = Option::deserialize(deserializer)?;
        opt.map(|r| match r {
            Repr::Num(n) => Ok(n),
            Repr::Str(s) => s.parse().map_err(serde::de::Error::custom),
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Wrap {
        #[serde(with = "super::u64_string")]
        v: u64,
        #[serde(with = "super::opt_u64_string")]
        o: Option<u64>,
    }

    #[test]
    fn round_trips_u64_max_exactly() {
        let w = Wrap { v: u64::MAX, o: Some(u64::MAX - 1) };
        let json = serde_json::to_string(&w).unwrap();
        assert!(json.contains("\"18446744073709551615\""));
        assert_eq!(serde_json::from_str::<Wrap>(&json).unwrap(), w);
    }

    #[test]
    fn accepts_bare_numbers_on_input() {
        let w: Wrap = serde_json::from_str(r#"{"v": 7, "o": null}"#).unwrap();
        assert_eq!(w, Wrap { v: 7, o: None });
    }
}
