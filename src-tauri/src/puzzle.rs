use std::{collections::VecDeque, path::PathBuf, sync::Mutex, fs::File, io::{Read, BufReader}};

use diesel::{dsl::sql, sql_types::Bool, Connection, ExpressionMethods, QueryDsl, RunQueryDsl, insert_into, connection::SimpleConnection};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;
use tauri::{path::BaseDirectory, Manager, Emitter};
use csv::ReaderBuilder;

use crate::{
    db::{puzzles, Puzzle},
    error::Error,
};

/// Cache for puzzles to reduce database queries
#[derive(Debug)]
struct PuzzleCache {
    /// Queue of puzzles loaded from the database
    cache: VecDeque<Puzzle>,
    /// Current position in the cache
    counter: usize,
    /// Minimum rating filter used for the current cache
    min_rating: u16,
    /// Maximum rating filter used for the current cache
    max_rating: u16,
    /// Maximum number of puzzles to cache at once
    cache_size: usize,
    /// Random flag used for the current cache
    random: bool,
    /// Themes filter used for the current cache
    themes: Option<Vec<String>>,
    /// Opening tags filter used for the current cache
    opening_tags: Option<Vec<String>>,
}

impl PuzzleCache {
    /// Create a new puzzle cache with default settings
    fn new() -> Self {
        Self {
            cache: VecDeque::new(),
            counter: 0,
            min_rating: 0,
            max_rating: 0,
            cache_size: 20, // Default cache size
            random: true,
            themes: None,
            opening_tags: None,
        }
    }

    /// Configure the cache size
    ///
    /// # Arguments
    /// * `size` - The maximum number of puzzles to cache at once
    #[allow(dead_code)]
    fn with_cache_size(mut self, size: usize) -> Self {
        self.cache_size = size;
        self
    }

    /// Loads puzzles into the cache if needed
    ///
    /// This method will reload the cache if:
    /// - The cache is empty
    /// - The rating filters have changed
    /// - We've reached the end of the current cache
    ///
    /// # Arguments
    /// * `file` - Path to the puzzle database
    /// * `min_rating` - Minimum puzzle rating to include
    /// * `max_rating` - Maximum puzzle rating to include
    /// * `random` - Randomize puzzle in cache
    /// * `themes` - Optional themes filter

    /// Loads puzzles into the cache with optional theme and opening tag filters
    fn get_puzzles_with_filters(
        &mut self,
        file: &str,
        min_rating: u16,
        max_rating: u16,
        random: bool,
        themes: Option<Vec<String>>,
        opening_tags: Option<Vec<String>>,
    ) -> Result<(), Error> {
        // Check if we need to reload the cache
        let themes_changed = self.themes != themes;
        let opening_tags_changed = self.opening_tags != opening_tags;
        
        if self.cache.is_empty()
            || self.min_rating != min_rating
            || self.max_rating != max_rating
            || self.random != random
            || themes_changed
            || opening_tags_changed
            || self.counter >= self.cache_size
        {
            self.cache.clear();
            self.counter = 0;

            let mut db = diesel::SqliteConnection::establish(file)?;
            let mut query = puzzles::table
                .filter(puzzles::rating.le(max_rating as i32))
                .filter(puzzles::rating.ge(min_rating as i32))
                .into_boxed();

            // Apply themes filter if provided
            if let Some(ref themes_list) = themes {
                if !themes_list.is_empty() {
                    // Filter puzzles that contain at least one of the selected themes
                    // Themes are stored as space-separated strings, so we need to check if any theme matches
                    // Build OR condition: (themes LIKE '% theme1 %' OR themes LIKE 'theme1 %' OR themes LIKE '% theme1' OR themes = 'theme1')
                    let or_clauses: Vec<String> = themes_list.iter()
                        .map(|theme| {
                            let escaped_theme = theme.replace("'", "''");
                            // Match theme as a complete word (at start, middle, or end of the string)
                            format!(
                                "(themes LIKE '% {} %' OR themes LIKE '{} %' OR themes LIKE '% {}' OR themes = '{}')",
                                escaped_theme, escaped_theme, escaped_theme, escaped_theme
                            )
                        })
                        .collect();
                    let sql_condition = format!("themes IS NOT NULL AND ({})", or_clauses.join(" OR "));
                    query = query.filter(sql::<Bool>(&sql_condition));
                }
            }

            // Apply opening_tags filter if provided
            if let Some(ref tags_list) = opening_tags {
                if !tags_list.is_empty() {
                    // Filter puzzles that contain at least one of the selected opening tags
                    // Opening tags are stored as space-separated strings, but we only care about the first word
                    // Build OR condition: (opening_tags LIKE 'tag1 %' OR opening_tags = 'tag1')
                    let or_clauses: Vec<String> = tags_list.iter()
                        .map(|tag| {
                            let escaped_tag = tag.replace("'", "''");
                            // Match tag as the first word (at start of string, followed by space or end of string)
                            format!(
                                "(opening_tags LIKE '{} %' OR opening_tags = '{}')",
                                escaped_tag, escaped_tag
                            )
                        })
                        .collect();
                    let sql_condition = format!("opening_tags IS NOT NULL AND ({})", or_clauses.join(" OR "));
                    query = query.filter(sql::<Bool>(&sql_condition));
                }
            }

            let new_puzzles = if random {
                query
                    .order(sql::<Bool>("RANDOM()"))
                    .limit(self.cache_size as i64)
                    .load::<Puzzle>(&mut db)?
            } else {
                query
                    .order(puzzles::id.asc())
                    .order(puzzles::rating.asc())
                    .limit(self.cache_size as i64)
                    .load::<Puzzle>(&mut db)?
            };

            self.cache = new_puzzles.into_iter().collect();
            self.min_rating = min_rating;
            self.max_rating = max_rating;
            self.random = random;
            self.themes = themes;
            self.opening_tags = opening_tags;
        }

        Ok(())
    }

    /// Gets the next puzzle from the cache
    ///
    /// # Returns
    /// * `Some(&Puzzle)` if a puzzle is available
    /// * `None` if no more puzzles are available in the cache
    fn get_next_puzzle(&mut self) -> Option<&Puzzle> {
        if let Some(puzzle) = self.cache.get(self.counter) {
            self.counter += 1;
            Some(puzzle)
        } else {
            None
        }
    }
}

/// Gets a random puzzle from the database within the specified rating range
///
/// This function uses a cache to avoid repeated database queries. The cache is
/// refreshed when it's empty, when the rating range changes, or when all puzzles
/// in the cache have been used.
///
/// # Arguments
/// * `file` - Path to the puzzle database
/// * `min_rating` - Minimum puzzle rating to include
/// * `max_rating` - Maximum puzzle rating to include
/// * `random` - Randomize puzzle in cache
/// * `themes` - Optional list of themes to filter by (puzzle must contain at least one)
/// * `opening_tags` - Optional list of opening tags to filter by (puzzle must contain at least one)
///
/// # Returns
/// * `Ok(Puzzle)` if a puzzle was found
/// * `Err(Error::NoPuzzles)` if no puzzles match the criteria
/// * Other errors if there was a problem accessing the database
#[tauri::command]
#[specta::specta]
pub fn get_puzzle(
    file: String,
    min_rating: u16,
    max_rating: u16,
    random: bool,
    themes: Option<Vec<String>>,
    opening_tags: Option<Vec<String>>,
) -> Result<Puzzle, Error> {
    static PUZZLE_CACHE: Lazy<Mutex<PuzzleCache>> = Lazy::new(|| Mutex::new(PuzzleCache::new()));

    let mut cache = PUZZLE_CACHE
        .lock()
        .map_err(|e| Error::MutexLockFailed(format!("Failed to lock puzzle cache: {}", e)))?;
    cache.get_puzzles_with_filters(&file, min_rating, max_rating, random, themes, opening_tags)?;
    // Get a reference to the next puzzle and clone it only if found
    match cache.get_next_puzzle() {
        Some(puzzle) => Ok(puzzle.clone()),
        None => Err(Error::NoPuzzles),
    }
}

/// Checks if a puzzle database has the themes and opening_tags columns
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok((has_themes, has_opening_tags))` indicating which columns exist
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn check_puzzle_db_columns(file: String) -> Result<(bool, bool), Error> {
    let mut db = diesel::SqliteConnection::establish(&file)?;
    
    // Use PRAGMA table_info to check if columns exist
    use diesel::sql_query;
    use diesel::prelude::*;
    
    #[derive(QueryableByName)]
    struct ColumnInfo {
        #[diesel(sql_type = diesel::sql_types::Text, column_name = "name")]
        name: String,
    }
    
    let columns: Vec<ColumnInfo> = sql_query("PRAGMA table_info(puzzles)")
        .load(&mut db)?;
    
    let has_themes = columns.iter().any(|col| col.name == "themes");
    let has_opening_tags = columns.iter().any(|col| col.name == "opening_tags");
    
    Ok((has_themes, has_opening_tags))
}

/// Gets distinct values for themes from a puzzle database
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok(Vec<String>)` with distinct theme values (split by space if multiple themes per puzzle)
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_themes(file: String) -> Result<Vec<String>, Error> {
    let mut db = diesel::SqliteConnection::establish(&file)?;
    
    // First check if themes column exists
    let (has_themes, _) = check_puzzle_db_columns(file.clone())?;
    if !has_themes {
        return Ok(Vec::new());
    }
    
    // Get all non-null themes
    let themes: Vec<Option<String>> = puzzles::table
        .select(puzzles::themes)
        .filter(puzzles::themes.is_not_null())
        .load(&mut db)?;
    
    // Extract and split themes (they are space-separated)
    let mut unique_themes = std::collections::HashSet::new();
    for theme_opt in themes {
        if let Some(theme_str) = theme_opt {
            // Split by whitespace and collect distinct themes
            for theme in theme_str.split_whitespace() {
                let trimmed = theme.trim().to_string();
                if !trimmed.is_empty() {
                    unique_themes.insert(trimmed);
                }
            }
        }
    }
    
    let mut result: Vec<String> = unique_themes.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Gets distinct values for opening_tags from a puzzle database
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok(Vec<String>)` with distinct opening tag values (only first word before space, split by space)
/// * `Err(Error)` if there was a problem accessing the database
#[allow(dead_code)] // Used by frontend via Tauri commands
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_opening_tags(file: String) -> Result<Vec<String>, Error> {
    let mut db = diesel::SqliteConnection::establish(&file)?;
    
    // First check if opening_tags column exists
    let (_, has_opening_tags) = check_puzzle_db_columns(file.clone())?;
    if !has_opening_tags {
        return Ok(Vec::new());
    }
    
    // Get all non-null opening_tags
    let opening_tags: Vec<Option<String>> = puzzles::table
        .select(puzzles::opening_tags)
        .filter(puzzles::opening_tags.is_not_null())
        .load(&mut db)?;
    
    // Extract and split opening_tags (they are space-separated)
    // Only take the first word (before the first space) from each tag
    let mut unique_tags = std::collections::HashSet::new();
    for tag_opt in opening_tags {
        if let Some(tag_str) = tag_opt {
            // Split by whitespace and take only the first word
            for tag in tag_str.split_whitespace() {
                // Take only the first word (everything before the first space is already handled by split_whitespace)
                let first_word = tag.trim().to_string();
                if !first_word.is_empty() {
                    unique_tags.insert(first_word);
                    // Only process the first word from each tag string
                    break;
                }
            }
        }
    }
    
    let mut result: Vec<String> = unique_tags.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Gets the minimum and maximum rating range from a puzzle database
///
/// This function queries the database to find the lowest and highest puzzle ratings.
///
/// # Arguments
/// * `file` - Path to the puzzle database
///
/// # Returns
/// * `Ok((min_rating, max_rating))` with the rating range
/// * `Err(Error)` if there was a problem accessing the database
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_rating_range(file: String) -> Result<(u16, u16), Error> {
    let mut db = diesel::SqliteConnection::establish(&file)?;
    
    let min_rating = puzzles::table
        .select(diesel::dsl::min(puzzles::rating))
        .first::<Option<i32>>(&mut db)?
        .unwrap_or(0) as u16;
    
    let max_rating = puzzles::table
        .select(diesel::dsl::max(puzzles::rating))
        .first::<Option<i32>>(&mut db)?
        .unwrap_or(0) as u16;
    
    Ok((min_rating, max_rating))
}

/// Information about a puzzle database
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseInfo {
    /// The title of the puzzle database (derived from filename)
    title: String,
    /// Description of the puzzle database (currently not populated)
    /// TODO: Consider adding a way to store and retrieve database descriptions
    description: String,
    /// Number of puzzles in the database
    puzzle_count: i32,
    /// Size of the database file in bytes
    storage_size: i64,
    /// Full path to the database file
    path: String,
}

/// Gets information about a puzzle database
///
/// This function retrieves metadata about a puzzle database, including:
/// - The title (derived from the filename)
/// - The number of puzzles in the database
/// - The size of the database file
/// - The full path to the database file
///
/// # Arguments
/// * `file` - Relative path to the puzzle database within the app's data directory
/// * `app` - Tauri app handle used to resolve the full path
///
/// # Returns
/// * `Ok(PuzzleDatabaseInfo)` with the database information
/// * `Err(Error)` if there was a problem accessing the database or file
#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_db_info(
    file: PathBuf,
    app: tauri::AppHandle,
) -> Result<PuzzleDatabaseInfo, Error> {
    // Ensure we're working with a relative path by checking if it's absolute
    let file_path = if file.is_absolute() {
        // If it's already absolute, use it directly
        file
    } else {
        // Otherwise, resolve it relative to the db directory in AppData
        let db_path = PathBuf::from("puzzles").join(file);
        app.path().resolve(db_path, BaseDirectory::AppData)?
    };

    // Verify the file actually exists before trying to open it
    if !file_path.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Puzzle database file does not exist: {}", file_path.display()),
        )));
    }

    // Verify the file is not empty (SQLite files should be at least a few bytes)
    let metadata = file_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Puzzle database file is empty: {}", file_path.display()),
        )));
    }

    let mut db = diesel::SqliteConnection::establish(&file_path.to_string_lossy())?;

    // Check if the puzzles table exists and get count safely
    let puzzle_count = match puzzles::table.count().get_result::<i64>(&mut db) {
        Ok(count) => count as i32,
        Err(diesel::result::Error::DatabaseError(kind, info)) => {
            // Check if the error is related to missing table
            if info.message().contains("no such table") {
                // Table doesn't exist - this could be an uninitialized database file
                // For safety, we return 0 instead of auto-initializing
                0
            } else {
                // For other database errors, propagate them
                return Err(Error::from(diesel::result::Error::DatabaseError(kind, info)));
            }
        }
        Err(e) => {
            // For other errors, propagate them
            return Err(Error::from(e));
        }
    };

    let storage_size = file_path.metadata()?.len() as i64;
    let filename = file_path
        .file_name()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid path: no filename",
            )
        })?
        .to_string_lossy();

    Ok(PuzzleDatabaseInfo {
        title: filename.to_string(),
        description: "".to_string(),
        puzzle_count,
        storage_size,
        path: file_path.to_string_lossy().to_string(),
    })
}

/// Imports puzzles from a local file into a new puzzle database
///
/// This function can handle different types of puzzle files:
/// - PGN files containing puzzles (with FEN positions and solution moves)
/// - Existing puzzle database files (.db, .db3)
/// - Compressed files (.zst)
///
/// # Arguments
/// * `source_file` - Path to the source puzzle file
/// * `db_path` - Path where the new puzzle database should be created
/// * `title` - Title for the puzzle database
/// * `description` - Optional description for the puzzle database
/// * `app` - Tauri app handle for progress events
///
/// # Returns
/// * `Ok(())` if import was successful
/// * `Err(Error)` if there was a problem importing the file
#[tauri::command]
#[specta::specta]
pub async fn import_puzzle_file(
    source_file: PathBuf,
    db_path: PathBuf,
    title: String,
    description: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    let description = description.unwrap_or_default();
    
    // Check if source file exists
    if !source_file.exists() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Source file not found",
        )));
    }

    // Create parent directory for the database if it doesn't exist
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Remove existing database file if it exists to avoid empty/corrupted files
    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!("Failed to remove existing database file '{}': {}", db_path.display(), e),
            ))
        })?;
    }

    // Check file extension and name to determine format
    let extension = source_file.extension().and_then(|ext| ext.to_str());
    let file_name = source_file.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    
    // Check if it's a CSV file (could be .csv or .csv.zst)
    let is_csv = file_name.ends_with(".csv") || file_name.ends_with(".csv.zst");
    
    match extension {
        Some("db") | Some("db3") => {
            // Copy existing puzzle database
            copy_puzzle_database(&source_file, &db_path, &title, &description).await
        }
        Some("pgn") => {
            // Parse PGN file and extract puzzles
            import_puzzles_from_pgn(&source_file, &db_path, &title, &description, &app).await
        }
        Some("zst") => {
            // Handle compressed files - check if it's CSV or PGN
            if is_csv {
                import_puzzles_from_csv_compressed(&source_file, &db_path, &title, &description, &app).await
            } else {
                import_puzzles_from_compressed(&source_file, &db_path, &title, &description, &app).await
            }
        }
        Some("csv") => {
            // Handle uncompressed CSV files
            import_puzzles_from_csv(&source_file, &db_path, &title, &description, &app).await
        }
        _ => Err(Error::UnsupportedFileFormat(format!(
            "Unsupported file format: {:?}",
            extension
        ))),
    }
}

/// Copies an existing puzzle database to a new location
async fn copy_puzzle_database(
    source_file: &PathBuf,
    db_path: &PathBuf,
    _title: &str,
    _description: &str,
) -> Result<(), Error> {
    // Copy the source database file to the destination path
    std::fs::copy(source_file, db_path)
        .map_err(|e| Error::IoError(std::io::Error::new(e.kind(), format!("Failed to copy database: {}", e))))?;
    Ok(())
}

/// Imports puzzles from a PGN file
async fn import_puzzles_from_pgn(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the puzzle database
    create_puzzle_database(db_path, title, description)?;
    
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    
    // Read and parse PGN file with better error handling
    let file = File::open(source_file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            e.kind(),
            format!("Failed to open file '{}': {}", source_file.display(), e),
        ))
    })?;
    
    let puzzles = parse_puzzles_from_pgn(file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to parse puzzles from '{}': {}", source_file.display(), e),
        ))
    })?;
    
    if puzzles.is_empty() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("No valid puzzles found in file '{}'", source_file.display()),
        )));
    }
    
    // Insert puzzles into database in batches
    let batch_size = 1000;
    let total_puzzles = puzzles.len();
    
    for (i, chunk) in puzzles.chunks(batch_size).enumerate() {
        db.transaction::<_, Error, _>(|db| {
            for puzzle in chunk {
                insert_into(puzzles::table)
                    .values(puzzle)
                    .execute(db)?;
            }
            Ok(())
        })?;
        
        // Emit progress event
        let processed = ((i + 1) * batch_size).min(total_puzzles);
        let _ = app.emit("import_puzzle_progress", (processed, total_puzzles));
    }
    
    Ok(())
}

/// Imports puzzles from a compressed file (PGN format)
async fn import_puzzles_from_compressed(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the puzzle database
    create_puzzle_database(db_path, title, description)?;
    
    let file = File::open(source_file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            e.kind(),
            format!("Failed to open compressed file '{}': {}", source_file.display(), e),
        ))
    })?;
    
    let decoder = zstd::Decoder::new(file).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to decompress file '{}': {}", source_file.display(), e),
        ))
    })?;
    
    let puzzles = parse_puzzles_from_pgn(decoder).map_err(|e| {
        Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to parse puzzles from compressed file '{}': {}", source_file.display(), e),
        ))
    })?;
    
    if puzzles.is_empty() {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("No valid puzzles found in compressed file '{}'", source_file.display()),
        )));
    }
    
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    
    // Insert puzzles into database in batches
    let batch_size = 1000;
    let total_puzzles = puzzles.len();
    
    for (i, chunk) in puzzles.chunks(batch_size).enumerate() {
        db.transaction::<_, Error, _>(|db| {
            for puzzle in chunk {
                insert_into(puzzles::table)
                    .values(puzzle)
                    .execute(db)?;
            }
            Ok(())
        })?;
        
        // Emit progress event
        let processed = ((i + 1) * batch_size).min(total_puzzles);
        let _ = app.emit("import_puzzle_progress", (processed, total_puzzles));
    }
    
    Ok(())
}

/// Imports puzzles from a CSV file
/// Uses streaming processing for better performance with large files
async fn import_puzzles_from_csv(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the database first (without indexes for faster insertion)
    create_puzzle_database(db_path, title, description)?;
    
    // Use a guard to clean up the database file if insertion fails
    let result = (|| -> Result<(), Error> {
        let file = File::open(source_file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!("Failed to open CSV file '{}': {}", source_file.display(), e),
            ))
        })?;
        
        let reader = BufReader::with_capacity(1024 * 1024, file); // 1MB buffer
        let mut csv_reader = ReaderBuilder::new()
            .has_headers(true)
            .from_reader(reader);
        
        let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
        
        // Apply additional performance optimizations
        db.batch_execute("PRAGMA journal_mode = WAL;")?;
        db.batch_execute("PRAGMA synchronous = NORMAL;")?;
        db.batch_execute("PRAGMA cache_size = -128000;")?; // 128MB cache for bulk insert
        db.batch_execute("PRAGMA temp_store = MEMORY;")?;
        db.batch_execute("PRAGMA mmap_size = 536870912;")?; // 512MB for bulk operations
        
        // Process puzzles in streaming batches
        let batch_size = 10000; // Increased from 1000 for better performance
        let mut batch = Vec::with_capacity(batch_size);
        let mut total_inserted = 0;
        let mut batch_count = 0;
        
        for result in csv_reader.deserialize() {
            let record: LichessPuzzleCsv = result.map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Failed to parse CSV record: {}", e),
                ))
            })?;
            
            // Skip puzzles with missing required fields
            if record.fen.is_empty() || record.moves.is_empty() {
                continue;
            }
            
            let puzzle = NewPuzzle {
                fen: record.fen,
                moves: record.moves,
                rating: record.rating.unwrap_or(1500),
                rating_deviation: record.rating_deviation.unwrap_or(350),
                popularity: record.popularity.unwrap_or(0),
                nb_plays: record.nb_plays.unwrap_or(0),
                themes: record.themes,
                game_url: record.game_url,
                opening_tags: record.opening_tags,
            };
            
            batch.push(puzzle);
            
            // Insert when batch is full
            if batch.len() >= batch_size {
                db.transaction::<_, Error, _>(|db| {
                    for puzzle in &batch {
                        insert_into(puzzles::table)
                            .values(puzzle)
                            .execute(db)?;
                    }
                    Ok(())
                })?;
                
                total_inserted += batch.len();
                batch_count += 1;
                
                // Emit progress event every 10 batches to avoid too many events
                if batch_count % 10 == 0 {
                    let _ = app.emit("import_puzzle_progress", (total_inserted, 0));
                }
                
                batch.clear();
            }
        }
        
        // Insert remaining puzzles
        if !batch.is_empty() {
            db.transaction::<_, Error, _>(|db| {
                for puzzle in &batch {
                    insert_into(puzzles::table)
                        .values(puzzle)
                        .execute(db)?;
                }
                Ok(())
            })?;
            total_inserted += batch.len();
        }
        
        if total_inserted == 0 {
            return Err(Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("No valid puzzles found in CSV file '{}'", source_file.display()),
            )));
        }
        
        // Emit final progress
        let _ = app.emit("import_puzzle_progress", (total_inserted, total_inserted));
        
        // Create indexes AFTER all data is inserted (much faster)
        create_puzzle_indexes(db_path)?;
        
        Ok(())
    })();
    
    // If insertion failed, remove the empty database file
    if result.is_err() && db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }
    
    result
}

/// Imports puzzles from a compressed CSV file (.csv.zst)
/// Uses streaming processing for better performance with large files
async fn import_puzzles_from_csv_compressed(
    source_file: &PathBuf,
    db_path: &PathBuf,
    title: &str,
    description: &str,
    app: &tauri::AppHandle,
) -> Result<(), Error> {
    // Create the database first (without indexes for faster insertion)
    create_puzzle_database(db_path, title, description)?;
    
    // Use a guard to clean up the database file if insertion fails
    let result = (|| -> Result<(), Error> {
        let file = File::open(source_file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                e.kind(),
                format!("Failed to open compressed CSV file '{}': {}", source_file.display(), e),
            ))
        })?;
        
        let decoder = zstd::Decoder::new(file).map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to decompress CSV file '{}': {}", source_file.display(), e),
            ))
        })?;
        
        let reader = BufReader::with_capacity(1024 * 1024, decoder); // 1MB buffer
        let mut csv_reader = ReaderBuilder::new()
            .has_headers(true)
            .from_reader(reader);
        
        let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
        
        // Apply additional performance optimizations
        db.batch_execute("PRAGMA journal_mode = WAL;")?;
        db.batch_execute("PRAGMA synchronous = NORMAL;")?;
        db.batch_execute("PRAGMA cache_size = -128000;")?; // 128MB cache for bulk insert
        db.batch_execute("PRAGMA temp_store = MEMORY;")?;
        db.batch_execute("PRAGMA mmap_size = 536870912;")?; // 512MB for bulk operations
        
        // Process puzzles in streaming batches
        let batch_size = 10000; // Increased from 1000 for better performance
        let mut batch = Vec::with_capacity(batch_size);
        let mut total_inserted = 0;
        let mut batch_count = 0;
        
        for result in csv_reader.deserialize() {
            let record: LichessPuzzleCsv = result.map_err(|e| {
                Error::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Failed to parse CSV record: {}", e),
                ))
            })?;
            
            // Skip puzzles with missing required fields
            if record.fen.is_empty() || record.moves.is_empty() {
                continue;
            }
            
            let puzzle = NewPuzzle {
                fen: record.fen,
                moves: record.moves,
                rating: record.rating.unwrap_or(1500),
                rating_deviation: record.rating_deviation.unwrap_or(350),
                popularity: record.popularity.unwrap_or(0),
                nb_plays: record.nb_plays.unwrap_or(0),
                themes: record.themes,
                game_url: record.game_url,
                opening_tags: record.opening_tags,
            };
            
            batch.push(puzzle);
            
            // Insert when batch is full
            if batch.len() >= batch_size {
                db.transaction::<_, Error, _>(|db| {
                    for puzzle in &batch {
                        insert_into(puzzles::table)
                            .values(puzzle)
                            .execute(db)?;
                    }
                    Ok(())
                })?;
                
                total_inserted += batch.len();
                batch_count += 1;
                
                // Emit progress event every 10 batches to avoid too many events
                if batch_count % 10 == 0 {
                    let _ = app.emit("import_puzzle_progress", (total_inserted, 0));
                }
                
                batch.clear();
            }
        }
        
        // Insert remaining puzzles
        if !batch.is_empty() {
            db.transaction::<_, Error, _>(|db| {
                for puzzle in &batch {
                    insert_into(puzzles::table)
                        .values(puzzle)
                        .execute(db)?;
                }
                Ok(())
            })?;
            total_inserted += batch.len();
        }
        
        if total_inserted == 0 {
            return Err(Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("No valid puzzles found in compressed CSV file '{}'", source_file.display()),
            )));
        }
        
        // Emit final progress
        let _ = app.emit("import_puzzle_progress", (total_inserted, total_inserted));
        
        // Create indexes AFTER all data is inserted (much faster)
        create_puzzle_indexes(db_path)?;
        
        Ok(())
    })();
    
    // If insertion failed, remove the empty database file
    if result.is_err() && db_path.exists() {
        let _ = std::fs::remove_file(&db_path);
    }
    
    result
}

/// Creates a new puzzle database with the proper schema
/// Note: Indexes are NOT created here - they should be created after bulk insert for better performance
fn create_puzzle_database(db_path: &PathBuf, _title: &str, _description: &str) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    
    // Load the schema from external SQL files
    const PUZZLES_TABLES: &str = include_str!("../../database/schema/puzzles_tables.sql");
    
    // Apply performance optimizations BEFORE creating tables
    db.batch_execute("PRAGMA journal_mode = WAL;")?;
    db.batch_execute("PRAGMA synchronous = NORMAL;")?;
    db.batch_execute("PRAGMA cache_size = -64000;")?; // 64MB cache
    db.batch_execute("PRAGMA temp_store = MEMORY;")?;
    db.batch_execute("PRAGMA mmap_size = 268435456;")?; // 256MB
    db.batch_execute("PRAGMA page_size = 4096;")?;
    
    // Create the puzzles table using the external schema
    db.batch_execute(PUZZLES_TABLES)?;
    
    // NOTE: Indexes are NOT created here - they will be created after bulk insert
    
    // Verify the database was created successfully by checking file size
    // SQLite databases should be at least a few KB after schema creation
    let metadata = db_path.metadata()?;
    if metadata.len() == 0 {
        return Err(Error::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to create puzzle database: file is empty after schema creation"),
        )));
    }
    
    Ok(())
}

/// Creates indexes on the puzzle database after bulk insert
fn create_puzzle_indexes(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    const PUZZLES_INDEXES: &str = include_str!("../../database/indexes/puzzles_indexes.sql");
    db.batch_execute(PUZZLES_INDEXES)?;
    Ok(())
}

/// Ensures that a database file has the proper puzzle schema initialized
/// 
/// This function checks if the puzzles table exists and creates it if missing.
/// This is useful for validating and repairing database files that may be 
/// empty or corrupted.
/// 
/// # Arguments
/// * `db_path` - Path to the database file
/// 
/// # Returns
/// * `Ok(())` if the schema exists or was successfully created
/// * `Err(Error)` if there was a problem initializing the schema
#[allow(dead_code)]
fn ensure_puzzle_schema(db_path: &PathBuf) -> Result<(), Error> {
    let mut db = diesel::SqliteConnection::establish(&db_path.to_string_lossy())?;
    
    // Check if puzzles table exists by trying to query it
    match puzzles::table.count().get_result::<i64>(&mut db) {
        Ok(_) => {
            // Table exists and is queryable
            Ok(())
        }
        Err(diesel::result::Error::DatabaseError(kind, info)) => {
            // Check if the error is related to missing table
            if info.message().contains("no such table") {
                // Table doesn't exist, create it
                const PUZZLES_TABLES: &str = include_str!("../../database/schema/puzzles_tables.sql");
                const PUZZLES_INDEXES: &str = include_str!("../../database/indexes/puzzles_indexes.sql");
                
                db.batch_execute(PUZZLES_TABLES)?;
                db.batch_execute(PUZZLES_INDEXES)?;
                Ok(())
            } else {
                // Other database error
                Err(Error::from(diesel::result::Error::DatabaseError(kind, info)))
            }
        }
        Err(e) => {
            // Other database error
            Err(Error::from(e))
        }
    }
}

/// Parses puzzles from a PGN reader
fn parse_puzzles_from_pgn<R: Read>(mut reader: R) -> Result<Vec<NewPuzzle>, Error> {
    let mut puzzles = Vec::new();
    let mut current_puzzle = NewPuzzle::default();
    let mut in_puzzle = false;
    
    // Read all bytes and convert to string with lossy UTF-8 conversion
    let mut buffer = Vec::new();
    reader.read_to_end(&mut buffer)?;
    
    // Convert bytes to string, replacing invalid UTF-8 sequences with replacement characters
    let content = String::from_utf8_lossy(&buffer);
    
    for line in content.lines() {
        let line = line.trim();
        
        if line.is_empty() {
            if in_puzzle && current_puzzle.is_complete() {
                puzzles.push(current_puzzle);
                current_puzzle = NewPuzzle::default();
                in_puzzle = false;
            }
            continue;
        }
        
        if line.starts_with('[') && line.ends_with(']') {
            // Parse PGN headers
            if let Some((key, value)) = parse_pgn_header(line) {
                match key.as_str() {
                    "FEN" => {
                        current_puzzle.fen = value;
                        in_puzzle = true;
                    }
                    "Solution" | "Moves" => {
                        current_puzzle.moves = value;
                    }
                    "Rating" | "Elo" => {
                        if let Ok(rating) = value.parse::<i32>() {
                            current_puzzle.rating = rating;
                        }
                    }
                    "Popularity" => {
                        if let Ok(popularity) = value.parse::<i32>() {
                            current_puzzle.popularity = popularity;
                        }
                    }
                    "NbPlays" => {
                        if let Ok(nb_plays) = value.parse::<i32>() {
                            current_puzzle.nb_plays = nb_plays;
                        }
                    }
                    _ => {}
                }
            }
        } else if !line.starts_with('[') && in_puzzle && current_puzzle.moves.is_empty() {
            // If we have a non-header line and no moves yet, treat it as moves
            current_puzzle.moves = line.to_string();
        }
    }
    
    // Add the last puzzle if complete
    if in_puzzle && current_puzzle.is_complete() {
        puzzles.push(current_puzzle);
    }
    
    Ok(puzzles)
}

/// Parses a PGN header line and returns the key-value pair
fn parse_pgn_header(line: &str) -> Option<(String, String)> {
    if !line.starts_with('[') || !line.ends_with(']') {
        return None;
    }
    
    let content = &line[1..line.len() - 1];
    let mut parts = content.splitn(2, ' ');
    
    let key = parts.next()?.to_string();
    let value = parts.next()?;
    
    // Remove quotes if present
    let value = if value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    };
    
    Some((key, value.to_string()))
}

/// Represents a new puzzle to be inserted into the database
#[derive(diesel::Insertable, Default)]
#[diesel(table_name = puzzles)]
struct NewPuzzle {
    fen: String,
    moves: String,
    rating: i32,
    rating_deviation: i32,
    popularity: i32,
    nb_plays: i32,
    themes: Option<String>,
    game_url: Option<String>,
    opening_tags: Option<String>,
}

impl NewPuzzle {
    fn is_complete(&self) -> bool {
        !self.fen.is_empty() && !self.moves.is_empty()
    }
}

/// Structure for deserializing Lichess puzzle CSV rows
#[derive(Debug, Deserialize)]
struct LichessPuzzleCsv {
    #[serde(rename = "PuzzleId")]
    #[allow(dead_code)]
    puzzle_id: String,
    #[serde(rename = "FEN")]
    fen: String,
    #[serde(rename = "Moves")]
    moves: String,
    #[serde(rename = "Rating")]
    rating: Option<i32>,
    #[serde(rename = "RatingDeviation")]
    rating_deviation: Option<i32>,
    #[serde(rename = "Popularity")]
    popularity: Option<i32>,
    #[serde(rename = "NbPlays")]
    nb_plays: Option<i32>,
    #[serde(rename = "Themes")]
    themes: Option<String>,
    #[serde(rename = "GameUrl")]
    game_url: Option<String>,
    #[serde(rename = "OpeningTags")]
    opening_tags: Option<String>,
}

/// Parses puzzles from a CSV reader
#[allow(dead_code)] // May be used in the future for CSV parsing
fn parse_puzzles_from_csv<R: Read>(reader: R) -> Result<Vec<NewPuzzle>, Error> {
    let mut csv_reader = ReaderBuilder::new()
        .has_headers(true)
        .from_reader(reader);
    
    let mut puzzles = Vec::new();
    
    for result in csv_reader.deserialize() {
        let record: LichessPuzzleCsv = result.map_err(|e| {
            Error::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse CSV record: {}", e),
            ))
        })?;
        
        // Skip puzzles with missing required fields
        if record.fen.is_empty() || record.moves.is_empty() {
            continue;
        }
        
        let puzzle = NewPuzzle {
            fen: record.fen,
            moves: record.moves,
            rating: record.rating.unwrap_or(1500),
            rating_deviation: record.rating_deviation.unwrap_or(350),
            popularity: record.popularity.unwrap_or(0),
            nb_plays: record.nb_plays.unwrap_or(0),
            themes: record.themes,
            game_url: record.game_url,
            opening_tags: record.opening_tags,
        };
        
        puzzles.push(puzzle);
    }
    
    Ok(puzzles)
}
