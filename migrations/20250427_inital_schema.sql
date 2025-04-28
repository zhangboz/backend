-- File: 20231027_initial_schema.sql
-- Description: Sets up the initial tables for the AI homework helper app.

-- Use BEGIN and COMMIT to make the whole script transactional.
-- If any statement fails, the entire transaction is rolled back.
BEGIN;

-- Drop tables in reverse order of creation to handle dependencies if resetting
DROP TABLE IF EXISTS temp_chat;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS universities;

-- Drop the custom enum type if it exists
DROP TYPE IF EXISTS question_enum;


-- Create the custom ENUM type for QuestionNumber
CREATE TYPE question_enum AS ENUM ('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10');


-- Table for Universities
CREATE TABLE universities (
    university VARCHAR(50) PRIMARY KEY, -- Short name like 'UBC', 'UofT'. Using VARCHAR with a reasonable limit. Made it PRIMARY KEY.
    full_name VARCHAR(255) NOT NULL    -- Full university name
);

-- Table for Users
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,          -- Auto-incrementing integer ID
    openid VARCHAR(100) UNIQUE NOT NULL, -- WeChat openid, should be unique and is required
    nickname VARCHAR(100),               -- User's nickname, optional
    university VARCHAR(50),              -- Foreign key to universities table

    -- Define the foreign key constraint
    CONSTRAINT fk_user_university
        FOREIGN KEY(university)
        REFERENCES universities(university)
        ON DELETE SET NULL   -- If a university is deleted, set the user's university to NULL
        ON UPDATE CASCADE    -- If a university's short code changes, update it here
);

-- Table for Courses
CREATE TABLE courses (
    -- CourseID alone might not be unique across universities, so use a composite key
    CourseID VARCHAR(20) NOT NULL,        -- Course code like 'MATH100'
    university VARCHAR(50) NOT NULL,      -- Foreign key to universities table (part of composite PK)
    CourseName VARCHAR(255) NOT NULL,     -- Full course name
    CourseSyllabus TEXT,                  -- AI-generated syllabus text

    -- Define the composite primary key
    PRIMARY KEY (university, CourseID),

    -- Define the foreign key constraint to universities
    CONSTRAINT fk_course_university
        FOREIGN KEY(university)
        REFERENCES universities(university)
        ON DELETE CASCADE    -- If a university is deleted, delete its courses
        ON UPDATE CASCADE    -- If a university's short code changes, update it here
);

-- Table for Temporary Chat/Homework Processing
CREATE TABLE temp_chat (
    -- Need a primary key for this table. Since a user has one chat instance with multiple questions,
    -- a composite key of user_id and QuestionNumber seems appropriate.
    user_id INTEGER NOT NULL,             -- Foreign key to users table
    QuestionNumber question_enum NOT NULL, -- The question number (Q1-Q10) using the enum type

    QuestionMarkdown TEXT,                -- Markdown text of the question
    AnswerMarkdown TEXT,                  -- Markdown text of the answer
    RelatedContext TEXT,                  -- Context from uploaded materials

    -- Need course info linked to the chat entry. Must include university for uniqueness.
    CourseID VARCHAR(20),                 -- Foreign key to courses table (part 1)
    university VARCHAR(50),               -- Foreign key to courses table (part 2)

    -- Define the composite primary key
    PRIMARY KEY (user_id, QuestionNumber),

    -- Define the foreign key constraint to users
    CONSTRAINT fk_chat_user
        FOREIGN KEY(user_id)
        REFERENCES users(user_id)
        ON DELETE CASCADE,   -- If the user is deleted, delete their chat entries

    -- Define the composite foreign key constraint to courses
    CONSTRAINT fk_chat_course
        FOREIGN KEY(university, CourseID)
        REFERENCES courses(university, CourseID)
        ON DELETE SET NULL   -- If the course is deleted, keep the chat entry but nullify the course link
        ON UPDATE CASCADE    -- If the course identifier changes, update it here
);

-- Add indexes for columns frequently used in WHERE clauses or JOINs (optional but good practice)
CREATE INDEX idx_users_openid ON users(openid);
CREATE INDEX idx_courses_name ON courses(CourseName); -- If you search by course name often
CREATE INDEX idx_temp_chat_course ON temp_chat(university, CourseID); -- For looking up chats by course


-- Commit the transaction
COMMIT;

-- Optional: Add a record to the tracking table if you're using one
-- INSERT INTO schema_migrations (version) VALUES ('20231027_initial_schema.sql');
-- (You would run this INSERT statement separately after successfully running the main script)