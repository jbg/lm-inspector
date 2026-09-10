//! Vocabulary paging/search over the tokenizer-derived (id, text) table.

use crate::worker::{VocabEntryDto, VocabPageDto};

pub fn page(
    vocabulary: &[(u32, String)],
    offset: u32,
    limit: u32,
    query: Option<&str>,
) -> VocabPageDto {
    let limit = limit.min(512) as usize;
    match query {
        Some(q) if !q.is_empty() => {
            let lower = q.to_lowercase();
            // Also allow searching by numeric id.
            let by_id: Option<u32> = q.parse().ok();
            let matches: Vec<&(u32, String)> = vocabulary
                .iter()
                .filter(|(id, text)| {
                    Some(*id) == by_id || text.to_lowercase().contains(&lower)
                })
                .collect();
            let total = matches.len() as u32;
            let entries = matches
                .into_iter()
                .skip(offset as usize)
                .take(limit)
                .map(|(id, text)| VocabEntryDto { id: *id, text: text.clone() })
                .collect();
            VocabPageDto { total, entries }
        }
        _ => VocabPageDto {
            total: vocabulary.len() as u32,
            entries: vocabulary
                .iter()
                .skip(offset as usize)
                .take(limit)
                .map(|(id, text)| VocabEntryDto { id: *id, text: text.clone() })
                .collect(),
        },
    }
}
