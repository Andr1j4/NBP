CREATE KEYSPACE IF NOT EXISTS turnir
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': '1'}
AND durable_writes = true;

CREATE TABLE IF NOT EXISTS turnir.game_archive (
    game_id uuid PRIMARY KEY,
    black_player uuid,
    board_number int,
    ended_at timestamp,
    final_fen text,
    reason text,
    result text,
    round int,
    started_at timestamp,
    tournament_id uuid,
    white_player uuid,
    san_moves list<text>
);

CREATE TABLE IF NOT EXISTS turnir.game_archive_by_id (
    game_id uuid PRIMARY KEY,
    black_player uuid,
    board_number int,
    created_at timestamp,
    end_time timestamp,
    final_fen text,
    reason text,
    result text,
    round int,
    start_time timestamp,
    time_control text,
    tournament_id uuid,
    white_player uuid,
    san_moves list<text>
);

CREATE TABLE IF NOT EXISTS turnir.game_moves (
    game_id uuid,
    move_number int,
    fen_state text,
    move text,
    player_color text,
    timestamp timestamp,
    PRIMARY KEY (game_id, move_number)
) WITH CLUSTERING ORDER BY (move_number ASC);

CREATE TABLE IF NOT EXISTS turnir.leaderboard (
    tournament_id uuid,
    rank int,
    player_id uuid,
    points float,
    PRIMARY KEY (tournament_id, rank, player_id)
) WITH CLUSTERING ORDER BY (rank ASC, player_id ASC);

CREATE TABLE IF NOT EXISTS turnir.leaderboard_by_player (
    tournament_id uuid,
    player_id uuid,
    points float,
    rank int,
    PRIMARY KEY (tournament_id, player_id)
) WITH CLUSTERING ORDER BY (player_id ASC);

CREATE TABLE IF NOT EXISTS turnir.matches (
    tournament_id uuid,
    round int,
    board_number int,
    black_player uuid,
    end_time timestamp,
    final_fen text,
    game_id uuid,
    result text,
    start_time timestamp,
    white_player uuid,
    PRIMARY KEY (tournament_id, round, board_number)
) WITH CLUSTERING ORDER BY (round ASC, board_number ASC);

CREATE TABLE IF NOT EXISTS turnir.matches_by_game (
    game_id uuid PRIMARY KEY,
    black_player uuid,
    board_number int,
    end_time timestamp,
    result text,
    round int,
    start_time timestamp,
    tournament_id uuid,
    white_player uuid
);

CREATE TABLE IF NOT EXISTS turnir.matches_by_player (
    tournament_id uuid,
    player_id uuid,
    round int,
    board_number int,
    color text,
    game_id uuid,
    result text,
    PRIMARY KEY ((tournament_id, player_id), round, board_number)
) WITH CLUSTERING ORDER BY (round ASC, board_number ASC);

CREATE TABLE IF NOT EXISTS turnir.players (
    player_id uuid PRIMARY KEY,
    country text,
    first_name text,
    last_name text,
    rating int
);

CREATE TABLE IF NOT EXISTS turnir.rounds_by_tournament (
    tournament_id uuid,
    round int,
    finished_at timestamp,
    started_at timestamp,
    PRIMARY KEY (tournament_id, round)
) WITH CLUSTERING ORDER BY (round ASC);

CREATE TABLE IF NOT EXISTS turnir.tournament_players (
    tournament_id uuid,
    player_id uuid,
    joined_at timestamp,
    rating int,
    PRIMARY KEY (tournament_id, player_id)
) WITH CLUSTERING ORDER BY (player_id ASC);

CREATE TABLE IF NOT EXISTS turnir.tournaments (
    tournament_id uuid PRIMARY KEY,
    champion_id uuid,
    created_at timestamp,
    created_by uuid,
    end_date date,
    location text,
    name text,
    start_date date,
    status text,
    time_control text,
    type text,
    winner_id uuid
);

CREATE TABLE IF NOT EXISTS turnir.tournaments_by_status (
    status text,
    start_date date,
    tournament_id uuid,
    location text,
    name text,
    time_control text,
    PRIMARY KEY (status, start_date, tournament_id)
) WITH CLUSTERING ORDER BY (start_date DESC, tournament_id ASC);

CREATE TABLE IF NOT EXISTS turnir.users_by_email (
    email text PRIMARY KEY,
    created_at timestamp,
    password_hash text,
    role text,
    user_id uuid
);

CREATE TABLE IF NOT EXISTS turnir.users_by_id (
    user_id uuid PRIMARY KEY,
    created_at timestamp,
    display_name text,
    email text,
    player_id uuid,
    role text
);

CREATE TABLE IF NOT EXISTS turnir.users_by_player (
    player_id uuid PRIMARY KEY,
    email text,
    user_id uuid
);
