#!/usr/bin/env python3
"""
MCP Server for AWS re:Invent Planner API
Provides tools to query and filter re:Invent sessions by various criteria.
Includes RSS feed monitoring and AWS events agenda with SQLite storage.
"""

import asyncio
import json
import logging
import sqlite3
import re
from typing import Any, Dict, List, Optional, Union
from datetime import datetime, timezone
from pathlib import Path

import httpx
import aiosqlite
import feedparser
from bs4 import BeautifulSoup
from icalendar import Calendar, Event as iCalEvent
from mcp.server import Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.server.models import ServerCapabilities
from mcp.types import (
    Resource,
    Tool,
    TextContent,
    ImageContent,
    EmbeddedResource,
    LoggingLevel
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("reinvent-planner")

# Global cache for catalog data
_catalog_cache: Optional[List[Dict[str, Any]]] = None
_cache_timestamp: Optional[datetime] = None
CACHE_DURATION_MINUTES = 30

# Database path
DB_PATH = Path(__file__).parent / "reinvent_data.db"

class ReinventPlannerServer:
    def __init__(self):
        self.server = Server("reinvent-planner")
        self.base_url = "https://reinvent-planner.cloud/api/aws/reinvent/2026"
        self.rss_url = "https://reinvent-planner.cloud/api/feed/rss"
        self.agenda_url = "https://reinvent.awsevents.com/agenda/"
        self.setup_tools()
        self.setup_resources()
        
    async def init_database(self):
        """Initialize SQLite database with required tables"""
        async with aiosqlite.connect(DB_PATH) as db:
            # Sessions table for catalog data
            await db.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    short_id TEXT,
                    title TEXT,
                    abstract TEXT,
                    start_datetime TEXT,
                    end_datetime TEXT,
                    day TEXT,
                    venue TEXT,
                    room TEXT,
                    level INTEGER,
                    type TEXT,
                    speakers TEXT,
                    services TEXT,
                    topics TEXT,
                    areas_of_interest TEXT,
                    last_modified TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # RSS feed items table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS rss_items (
                    guid TEXT PRIMARY KEY,
                    title TEXT,
                    description TEXT,
                    link TEXT,
                    pub_date TEXT,
                    category TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # AWS events agenda table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS aws_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT,
                    time TEXT,
                    title TEXT,
                    description TEXT,
                    location TEXT,
                    duration TEXT,
                    event_type TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            

            
            # Data sync log table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS sync_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT,
                    sync_type TEXT,
                    items_processed INTEGER,
                    items_new INTEGER,
                    items_updated INTEGER,
                    status TEXT,
                    error_message TEXT,
                    sync_timestamp TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Personal events table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS personal_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT,
                    start_datetime TEXT NOT NULL,
                    end_datetime TEXT NOT NULL,
                    location TEXT,
                    event_type TEXT DEFAULT 'personal',
                    notes TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Favorite sessions lists table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS favorite_lists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    list_name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Favorite sessions table
            await db.execute("""
                CREATE TABLE IF NOT EXISTS favorite_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    list_name TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    session_short_id TEXT,
                    session_title TEXT,
                    notes TEXT,
                    priority INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (list_name) REFERENCES favorite_lists (list_name) ON DELETE CASCADE,
                    UNIQUE(list_name, session_id)
                )
            """)
            
            # Create default favorite lists
            await db.execute("""
                INSERT OR IGNORE INTO favorite_lists (list_name, description) VALUES 
                ('preselection', 'Sessions présélectionnées à examiner'),
                ('plan_a', 'Plan A - Sessions prioritaires'),
                ('plan_b', 'Plan B - Sessions alternatives'),
                ('plan_c', 'Plan C - Sessions de secours')
            """)
            
            await db.commit()

    async def fetch_catalog(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """Fetch catalog data with caching and database storage"""
        global _catalog_cache, _cache_timestamp
        
        now = datetime.now()
        if (not force_refresh and 
            _catalog_cache is not None and 
            _cache_timestamp is not None and 
            (now - _cache_timestamp).total_seconds() < CACHE_DURATION_MINUTES * 60):
            return _catalog_cache
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(f"{self.base_url}/catalog")
                response.raise_for_status()
                data = response.json()
                
                _catalog_cache = data.get("catalog", [])
                _cache_timestamp = now
                logger.info(f"Fetched {len(_catalog_cache)} sessions from API")
                
                # Store in database
                await self.store_sessions_in_db(_catalog_cache)
                
                return _catalog_cache
                
        except Exception as e:
            logger.error(f"Error fetching catalog: {e}")
            if _catalog_cache is not None:
                logger.info("Using cached data due to API error")
                return _catalog_cache
            raise
    
    async def store_sessions_in_db(self, sessions: List[Dict[str, Any]]):
        """Store sessions in SQLite database"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            items_processed = 0
            items_new = 0
            items_updated = 0
            
            for session in sessions:
                try:
                    # Check if session exists
                    cursor = await db.execute("SELECT id FROM sessions WHERE id = ?", (session.get("id"),))
                    exists = await cursor.fetchone()
                    
                    # Prepare data
                    speakers = json.dumps([s.get("displayName", "") for s in session.get("speakers", [])])
                    services = json.dumps([s.get("displayName", "") for s in session.get("services", [])])
                    topics = json.dumps([t.get("displayName", "") for t in session.get("topics", [])])
                    areas = json.dumps([a.get("displayName", "") for a in session.get("areaOfInterest", [])])
                    
                    if exists:
                        # Update existing
                        await db.execute("""
                            UPDATE sessions SET 
                                short_id=?, title=?, abstract=?, start_datetime=?, end_datetime=?,
                                day=?, venue=?, room=?, level=?, type=?, speakers=?, services=?,
                                topics=?, areas_of_interest=?, last_modified=?, updated_at=CURRENT_TIMESTAMP
                            WHERE id=?
                        """, (
                            session.get("shortId"), session.get("title"), session.get("abstract"),
                            session.get("startDateTime"), session.get("endDateTime"),
                            session.get("day"), session.get("venue", {}).get("displayName"),
                            session.get("venueRoomName"), session.get("level", {}).get("value"),
                            session.get("type", {}).get("displayName"), speakers, services,
                            topics, areas, session.get("lastModified"), session.get("id")
                        ))
                        items_updated += 1
                    else:
                        # Insert new
                        await db.execute("""
                            INSERT INTO sessions (
                                id, short_id, title, abstract, start_datetime, end_datetime,
                                day, venue, room, level, type, speakers, services,
                                topics, areas_of_interest, last_modified
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            session.get("id"), session.get("shortId"), session.get("title"),
                            session.get("abstract"), session.get("startDateTime"), session.get("endDateTime"),
                            session.get("day"), session.get("venue", {}).get("displayName"),
                            session.get("venueRoomName"), session.get("level", {}).get("value"),
                            session.get("type", {}).get("displayName"), speakers, services,
                            topics, areas, session.get("lastModified")
                        ))
                        items_new += 1
                    
                    items_processed += 1
                    
                except Exception as e:
                    logger.error(f"Error storing session {session.get('id', 'unknown')}: {e}")
            
            await db.commit()
            
            # Log sync
            await db.execute("""
                INSERT INTO sync_log (source, sync_type, items_processed, items_new, items_updated, status)
                VALUES (?, ?, ?, ?, ?, ?)
            """, ("catalog", "sessions", items_processed, items_new, items_updated, "success"))
            await db.commit()
            
            logger.info(f"Stored sessions: {items_processed} processed, {items_new} new, {items_updated} updated")
    
    async def fetch_and_store_rss_feed(self) -> Dict[str, Any]:
        """Fetch RSS feed and store new items in database"""
        await self.init_database()
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.rss_url)
                response.raise_for_status()
                
                # Parse RSS feed
                feed = feedparser.parse(response.text)
                
                async with aiosqlite.connect(DB_PATH) as db:
                    items_processed = 0
                    items_new = 0
                    
                    for entry in feed.entries:
                        try:
                            # Check if item exists
                            cursor = await db.execute("SELECT guid FROM rss_items WHERE guid = ?", (entry.id,))
                            exists = await cursor.fetchone()
                            
                            if not exists:
                                await db.execute("""
                                    INSERT INTO rss_items (guid, title, description, link, pub_date, category)
                                    VALUES (?, ?, ?, ?, ?, ?)
                                """, (
                                    entry.id, entry.title, entry.description, entry.link,
                                    entry.published, getattr(entry, 'category', '')
                                ))
                                items_new += 1
                            
                            items_processed += 1
                            
                        except Exception as e:
                            logger.error(f"Error storing RSS item {entry.id}: {e}")
                    
                    await db.commit()
                    
                    # Log sync
                    await db.execute("""
                        INSERT INTO sync_log (source, sync_type, items_processed, items_new, items_updated, status)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, ("rss", "feed_items", items_processed, items_new, 0, "success"))
                    await db.commit()
                    
                    logger.info(f"RSS sync: {items_processed} processed, {items_new} new items")
                    
                    return {
                        "status": "success",
                        "items_processed": items_processed,
                        "items_new": items_new,
                        "feed_title": feed.feed.get("title", ""),
                        "feed_description": feed.feed.get("description", ""),
                        "last_build_date": feed.feed.get("lastbuilddate", "")
                    }
                    
        except Exception as e:
            logger.error(f"Error fetching RSS feed: {e}")
            # Log error
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute("""
                    INSERT INTO sync_log (source, sync_type, items_processed, items_new, items_updated, status, error_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, ("rss", "feed_items", 0, 0, 0, "error", str(e)))
                await db.commit()
            raise
    
    async def fetch_and_store_aws_events(self) -> Dict[str, Any]:
        """Fetch AWS events agenda and store in database"""
        await self.init_database()
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.agenda_url)
                response.raise_for_status()
                
                soup = BeautifulSoup(response.text, 'html.parser')
                
                async with aiosqlite.connect(DB_PATH) as db:
                    # Clear existing events for fresh data
                    await db.execute("DELETE FROM aws_events")
                    
                    items_processed = 0
                    current_date = ""
                    
                    # Parse the agenda structure
                    for element in soup.find_all(['h2', 'h3', 'li']):
                        try:
                            if element.name == 'h2' and 'day' in element.get_text().lower():
                                # Extract date from headers like "Monday, December 1"
                                current_date = element.get_text().strip()
                            
                            elif element.name in ['h3', 'li']:
                                text = element.get_text().strip()
                                
                                # Look for time patterns
                                time_match = re.search(r'(\d{1,2}:\d{2}\s*(?:AM|PM))', text)
                                if time_match:
                                    time = time_match.group(1)
                                    
                                    # Extract event details
                                    lines = text.split('\n')
                                    title = lines[0] if lines else ""
                                    
                                    # Look for location and duration info
                                    location = ""
                                    duration = ""
                                    description = ""
                                    
                                    for line in lines[1:]:
                                        line = line.strip()
                                        if line and not line.startswith('Learn more'):
                                            if any(venue in line for venue in ['Venetian', 'MGM', 'Caesars', 'Mandalay', 'Wynn', 'Encore']):
                                                location = line
                                            elif '–' in line and ('AM' in line or 'PM' in line):
                                                duration = line
                                            else:
                                                description += line + " "
                                    
                                    # Determine event type
                                    event_type = "General"
                                    if "keynote" in title.lower():
                                        event_type = "Keynote"
                                    elif "session" in title.lower():
                                        event_type = "Session"
                                    elif "expo" in title.lower():
                                        event_type = "Expo"
                                    elif "reception" in title.lower() or "party" in title.lower():
                                        event_type = "Social"
                                    elif "breakfast" in title.lower() or "lunch" in title.lower():
                                        event_type = "Meal"
                                    
                                    await db.execute("""
                                        INSERT INTO aws_events (date, time, title, description, location, duration, event_type)
                                        VALUES (?, ?, ?, ?, ?, ?, ?)
                                    """, (current_date, time, title, description.strip(), location, duration, event_type))
                                    
                                    items_processed += 1
                                    
                        except Exception as e:
                            logger.error(f"Error parsing AWS event: {e}")
                    
                    await db.commit()
                    
                    # Log sync
                    await db.execute("""
                        INSERT INTO sync_log (source, sync_type, items_processed, items_new, items_updated, status)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, ("aws_events", "agenda", items_processed, items_processed, 0, "success"))
                    await db.commit()
                    
                    logger.info(f"AWS events sync: {items_processed} events processed")
                    
                    return {
                        "status": "success",
                        "items_processed": items_processed,
                        "items_new": items_processed
                    }
                    
        except Exception as e:
            logger.error(f"Error fetching AWS events: {e}")
            # Log error
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute("""
                    INSERT INTO sync_log (source, sync_type, items_processed, items_new, items_updated, status, error_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, ("aws_events", "agenda", 0, 0, 0, "error", str(e)))
                await db.commit()
            raise

    def setup_resources(self):
        """Setup MCP resources"""
        
        @self.server.list_resources()
        async def list_resources() -> List[Resource]:
            return [
                Resource(
                    uri="reinvent://catalog",
                    name="AWS re:Invent Session Catalog",
                    description="Complete catalog of AWS re:Invent sessions",
                    mimeType="application/json"
                )
            ]

        @self.server.read_resource()
        async def read_resource(uri: str) -> str:
            if uri == "reinvent://catalog":
                catalog = await self.fetch_catalog()
                return json.dumps({"catalog": catalog}, indent=2)
            else:
                raise ValueError(f"Unknown resource: {uri}")

    def setup_tools(self):
        """Setup MCP tools"""
        
        @self.server.list_tools()
        async def list_tools() -> List[Tool]:
            return [
                Tool(
                    name="search_sessions",
                    description="Search re:Invent sessions with flexible filtering options",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query for title, abstract, or speaker names"
                            },
                            "day": {
                                "type": "string",
                                "description": "Filter by day (Monday, Tuesday, Wednesday, Thursday, Friday)"
                            },
                            "venue": {
                                "type": "string", 
                                "description": "Filter by venue (e.g., 'Venetian', 'MGM')"
                            },
                            "level": {
                                "type": "integer",
                                "description": "Filter by level (100, 200, 300, 400)"
                            },
                            "service": {
                                "type": "string",
                                "description": "Filter by AWS service"
                            },
                            "topic": {
                                "type": "string", 
                                "description": "Filter by topic"
                            },
                            "type": {
                                "type": "string",
                                "description": "Filter by session type (e.g., 'Lightning talk', 'Breakout session')"
                            },
                            "area_of_interest": {
                                "type": "string",
                                "description": "Filter by area of interest"
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of results to return (default: 50)",
                                "default": 50
                            }
                        }
                    }
                ),
                Tool(
                    name="get_session_details",
                    description="Get detailed information about a specific session",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "Session ID or short ID (e.g., 'DVT222-S')"
                            }
                        },
                        "required": ["session_id"]
                    }
                ),
                Tool(
                    name="list_available_filters",
                    description="Get all available filter values for days, venues, levels, services, topics, etc.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "filter_type": {
                                "type": "string",
                                "description": "Type of filter to list: 'days', 'venues', 'levels', 'services', 'topics', 'types', 'areas_of_interest', 'all'",
                                "default": "all"
                            }
                        }
                    }
                ),
                Tool(
                    name="get_schedule_by_day",
                    description="Get all sessions for a specific day with time information",
                    inputSchema={
                        "type": "object", 
                        "properties": {
                            "day": {
                                "type": "string",
                                "description": "Day to get schedule for (Monday, Tuesday, Wednesday, Thursday, Friday)"
                            },
                            "venue": {
                                "type": "string",
                                "description": "Optional: filter by specific venue"
                            }
                        },
                        "required": ["day"]
                    }
                ),
                Tool(
                    name="get_rss_updates",
                    description="Get latest session updates from RSS feed",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of RSS items to return (default: 10)",
                                "default": 10
                            },
                            "category": {
                                "type": "string",
                                "description": "Filter by category (e.g., 'Keynote', 'Breakout session')"
                            }
                        }
                    }
                ),
                Tool(
                    name="sync_rss_feed",
                    description="Manually sync RSS feed to get latest updates",
                    inputSchema={
                        "type": "object",
                        "properties": {}
                    }
                ),
                Tool(
                    name="get_aws_events",
                    description="Get AWS official events from the agenda",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "day": {
                                "type": "string",
                                "description": "Filter by day (e.g., 'Monday', 'Tuesday')"
                            },
                            "event_type": {
                                "type": "string",
                                "description": "Filter by event type (Keynote, Session, Expo, Social, Meal, General)"
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of events to return (default: 50)",
                                "default": 50
                            }
                        }
                    }
                ),
                Tool(
                    name="sync_aws_events",
                    description="Manually sync AWS events agenda",
                    inputSchema={
                        "type": "object",
                        "properties": {}
                    }
                ),
                Tool(
                    name="sync_all_data",
                    description="Sync all data sources (RSS, AWS events)",
                    inputSchema={
                        "type": "object",
                        "properties": {}
                    }
                ),
                Tool(
                    name="get_sync_history",
                    description="Get synchronization history and statistics",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "source": {
                                "type": "string",
                                "description": "Filter by data source (catalog, rss, aws_events)"
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of sync records to return (default: 20)",
                                "default": 20
                            }
                        }
                    }
                ),
                Tool(
                    name="add_personal_event",
                    description="Add a personal event to your re:Invent schedule",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "Event title"
                            },
                            "description": {
                                "type": "string",
                                "description": "Event description"
                            },
                            "start_datetime": {
                                "type": "string",
                                "description": "Start date and time (YYYY-MM-DD HH:MM format)"
                            },
                            "end_datetime": {
                                "type": "string",
                                "description": "End date and time (YYYY-MM-DD HH:MM format)"
                            },
                            "location": {
                                "type": "string",
                                "description": "Event location"
                            },
                            "event_type": {
                                "type": "string",
                                "description": "Event type (meeting, meal, travel, personal, etc.)",
                                "default": "personal"
                            },
                            "notes": {
                                "type": "string",
                                "description": "Additional notes"
                            }
                        },
                        "required": ["title", "start_datetime", "end_datetime"]
                    }
                ),
                Tool(
                    name="get_personal_events",
                    description="Get your personal events",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "day": {
                                "type": "string",
                                "description": "Filter by day (e.g., 'Monday', 'Tuesday')"
                            },
                            "event_type": {
                                "type": "string",
                                "description": "Filter by event type"
                            }
                        }
                    }
                ),
                Tool(
                    name="delete_personal_event",
                    description="Delete a personal event",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "event_id": {
                                "type": "integer",
                                "description": "ID of the event to delete"
                            }
                        },
                        "required": ["event_id"]
                    }
                ),
                Tool(
                    name="add_session_to_favorites",
                    description="Add a session to a favorite list",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "Session ID or short ID"
                            },
                            "list_name": {
                                "type": "string",
                                "description": "List name (preselection, plan_a, plan_b, plan_c)",
                                "enum": ["preselection", "plan_a", "plan_b", "plan_c"]
                            },
                            "notes": {
                                "type": "string",
                                "description": "Personal notes about this session"
                            },
                            "priority": {
                                "type": "integer",
                                "description": "Priority level (1-5, 1 being highest)",
                                "default": 1
                            }
                        },
                        "required": ["session_id", "list_name"]
                    }
                ),
                Tool(
                    name="get_favorite_sessions",
                    description="Get sessions from a favorite list",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "list_name": {
                                "type": "string",
                                "description": "List name (preselection, plan_a, plan_b, plan_c, or 'all' for all lists)",
                                "default": "all"
                            }
                        }
                    }
                ),
                Tool(
                    name="remove_session_from_favorites",
                    description="Remove a session from a favorite list",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "Session ID or short ID"
                            },
                            "list_name": {
                                "type": "string",
                                "description": "List name (preselection, plan_a, plan_b, plan_c)"
                            }
                        },
                        "required": ["session_id", "list_name"]
                    }
                ),
                Tool(
                    name="export_schedule_to_ical",
                    description="Export favorite sessions and personal events to iCal format for Outlook",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "list_name": {
                                "type": "string",
                                "description": "Favorite list to export (preselection, plan_a, plan_b, plan_c, or 'all')",
                                "default": "all"
                            },
                            "include_personal_events": {
                                "type": "boolean",
                                "description": "Include personal events in export",
                                "default": True
                            },
                            "filename": {
                                "type": "string",
                                "description": "Output filename (without extension)",
                                "default": "reinvent_schedule"
                            }
                        }
                    }
                ),
                Tool(
                    name="create_favorite_list",
                    description="Create a custom favorite list",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "list_name": {
                                "type": "string",
                                "description": "Name of the new list"
                            },
                            "description": {
                                "type": "string",
                                "description": "Description of the list"
                            }
                        },
                        "required": ["list_name"]
                    }
                )
            ]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
            try:
                if name == "search_sessions":
                    return await self.search_sessions(**arguments)
                elif name == "get_session_details":
                    return await self.get_session_details(**arguments)
                elif name == "list_available_filters":
                    return await self.list_available_filters(**arguments)
                elif name == "get_schedule_by_day":
                    return await self.get_schedule_by_day(**arguments)
                elif name == "get_rss_updates":
                    return await self.get_rss_updates(**arguments)
                elif name == "sync_rss_feed":
                    return await self.sync_rss_feed(**arguments)
                elif name == "get_aws_events":
                    return await self.get_aws_events(**arguments)
                elif name == "sync_aws_events":
                    return await self.sync_aws_events(**arguments)
                elif name == "sync_all_data":
                    return await self.sync_all_data(**arguments)
                elif name == "get_sync_history":
                    return await self.get_sync_history(**arguments)
                elif name == "add_personal_event":
                    return await self.add_personal_event(**arguments)
                elif name == "get_personal_events":
                    return await self.get_personal_events(**arguments)
                elif name == "delete_personal_event":
                    return await self.delete_personal_event(**arguments)
                elif name == "add_session_to_favorites":
                    return await self.add_session_to_favorites(**arguments)
                elif name == "get_favorite_sessions":
                    return await self.get_favorite_sessions(**arguments)
                elif name == "remove_session_from_favorites":
                    return await self.remove_session_from_favorites(**arguments)
                elif name == "export_schedule_to_ical":
                    return await self.export_schedule_to_ical(**arguments)
                elif name == "create_favorite_list":
                    return await self.create_favorite_list(**arguments)
                else:
                    raise ValueError(f"Unknown tool: {name}")
            except Exception as e:
                logger.error(f"Error in tool {name}: {e}")
                return [TextContent(type="text", text=f"Error: {str(e)}")]

    async def search_sessions(self, query: Optional[str] = None, day: Optional[str] = None,
                            venue: Optional[str] = None, level: Optional[int] = None,
                            service: Optional[str] = None, topic: Optional[str] = None,
                            type: Optional[str] = None, area_of_interest: Optional[str] = None,
                            limit: int = 50) -> List[TextContent]:
        """Search sessions with various filters"""
        catalog = await self.fetch_catalog()
        results = []
        
        for session in catalog:
            # Apply filters
            if day and session.get("day", "").lower() != day.lower():
                continue
                
            if venue and venue.lower() not in session.get("venue", {}).get("displayName", "").lower():
                continue
                
            if level and session.get("level", {}).get("value") != level:
                continue
                
            if service:
                session_services = [s.get("displayName", "") for s in session.get("services", [])]
                if not any(service.lower() in s.lower() for s in session_services):
                    continue
                    
            if topic:
                session_topics = [t.get("displayName", "") for t in session.get("topics", [])]
                if not any(topic.lower() in t.lower() for t in session_topics):
                    continue
                    
            if type and type.lower() not in session.get("type", {}).get("displayName", "").lower():
                continue
                
            if area_of_interest:
                session_areas = [a.get("displayName", "") for a in session.get("areaOfInterest", [])]
                if not any(area_of_interest.lower() in a.lower() for a in session_areas):
                    continue
            
            # Apply text search
            if query:
                searchable_text = " ".join([
                    session.get("title", ""),
                    session.get("abstract", ""),
                    " ".join([s.get("displayName", "") for s in session.get("speakers", [])])
                ]).lower()
                
                if query.lower() not in searchable_text:
                    continue
            
            results.append(session)
            
            if len(results) >= limit:
                break
        
        # Format results
        if not results:
            return [TextContent(type="text", text="No sessions found matching your criteria.")]
        
        formatted_results = []
        formatted_results.append(f"Found {len(results)} session(s):\n")
        
        for session in results:
            speakers = ", ".join([s.get("displayName", "") for s in session.get("speakers", [])])
            level_info = session.get("level", {})
            level_display = f"{level_info.get('value', 'N/A')} - {level_info.get('displayName', 'N/A')}"
            
            formatted_results.append(
                f"**{session.get('shortId', 'N/A')}** - {session.get('title', 'N/A')}\n"
                f"📅 {session.get('day', 'N/A')} at {session.get('startTime', 'N/A')}-{session.get('endTime', 'N/A')}\n"
                f"📍 {session.get('venueRoomName', 'N/A')}\n"
                f"👥 {speakers}\n"
                f"📊 Level: {level_display}\n"
                f"🏷️ Type: {session.get('type', {}).get('displayName', 'N/A')}\n"
                f"💺 Capacity: {session.get('seatCapacity', 'N/A')}\n"
                f"📝 {session.get('abstract', 'N/A')[:200]}{'...' if len(session.get('abstract', '')) > 200 else ''}\n"
                f"---\n"
            )
        
        return [TextContent(type="text", text="\n".join(formatted_results))]

    async def get_session_details(self, session_id: str) -> List[TextContent]:
        """Get detailed information about a specific session"""
        catalog = await self.fetch_catalog()
        
        # Find session by ID or shortId
        session = None
        for s in catalog:
            if s.get("id") == session_id or s.get("shortId") == session_id:
                session = s
                break
        
        if not session:
            return [TextContent(type="text", text=f"Session not found: {session_id}")]
        
        # Format detailed session information
        speakers = "\n".join([
            f"  - {s.get('displayName', 'N/A')} ({s.get('company', 'N/A')})" 
            for s in session.get("speakers", [])
        ])
        
        services = ", ".join([s.get("displayName", "") for s in session.get("services", [])])
        topics = ", ".join([t.get("displayName", "") for t in session.get("topics", [])])
        areas = ", ".join([a.get("displayName", "") for a in session.get("areaOfInterest", [])])
        roles = ", ".join([r.get("displayName", "") for r in session.get("role", [])])
        features = ", ".join([f.get("displayName", "") for f in session.get("features", [])])
        
        level_info = session.get("level", {})
        level_display = f"{level_info.get('value', 'N/A')} - {level_info.get('displayName', 'N/A')}"
        
        details = f"""
**{session.get('shortId', 'N/A')}** - {session.get('title', 'N/A')}

📅 **Schedule:**
  - Day: {session.get('day', 'N/A')}
  - Time: {session.get('startTime', 'N/A')} - {session.get('endTime', 'N/A')}
  - Duration: 20 minutes

📍 **Location:**
  - Venue: {session.get('venue', {}).get('displayName', 'N/A')}
  - Room: {session.get('venueRoomName', 'N/A')}
  - Capacity: {session.get('seatCapacity', 'N/A')} seats

👥 **Speakers:**
{speakers}

📊 **Session Info:**
  - Level: {level_display}
  - Type: {session.get('type', {}).get('displayName', 'N/A')}
  - Services: {services or 'None specified'}
  - Topics: {topics or 'None specified'}

🏷️ **Tags & Categories:**
  - Areas of Interest: {areas or 'None specified'}
  - Target Roles: {roles or 'None specified'}
  - Features: {features or 'None specified'}

📝 **Abstract:**
{session.get('abstract', 'No abstract available')}

🔗 **Session ID:** {session.get('id', 'N/A')}
📝 **Last Modified:** {session.get('lastModified', 'N/A')}
"""
        
        return [TextContent(type="text", text=details.strip())]

    async def list_available_filters(self, filter_type: str = "all") -> List[TextContent]:
        """List all available filter values"""
        catalog = await self.fetch_catalog()
        
        filters = {
            "days": set(),
            "venues": set(), 
            "levels": set(),
            "services": set(),
            "topics": set(),
            "types": set(),
            "areas_of_interest": set(),
            "roles": set(),
            "features": set()
        }
        
        for session in catalog:
            filters["days"].add(session.get("day", ""))
            filters["venues"].add(session.get("venue", {}).get("displayName", ""))
            
            level = session.get("level", {})
            if level.get("value"):
                filters["levels"].add(f"{level.get('value')} - {level.get('displayName', '')}")
            
            for service in session.get("services", []):
                filters["services"].add(service.get("displayName", ""))
                
            for topic in session.get("topics", []):
                filters["topics"].add(topic.get("displayName", ""))
                
            filters["types"].add(session.get("type", {}).get("displayName", ""))
            
            for area in session.get("areaOfInterest", []):
                filters["areas_of_interest"].add(area.get("displayName", ""))
                
            for role in session.get("role", []):
                filters["roles"].add(role.get("displayName", ""))
                
            for feature in session.get("features", []):
                filters["features"].add(feature.get("displayName", ""))
        
        # Remove empty strings
        for key in filters:
            filters[key] = sorted([item for item in filters[key] if item])
        
        if filter_type != "all" and filter_type in filters:
            result = f"**Available {filter_type}:**\n"
            result += "\n".join([f"  - {item}" for item in filters[filter_type]])
            return [TextContent(type="text", text=result)]
        
        # Return all filters
        result = []
        for key, values in filters.items():
            if values:
                result.append(f"**{key.replace('_', ' ').title()}:**")
                result.extend([f"  - {item}" for item in values[:10]])  # Limit to first 10
                if len(values) > 10:
                    result.append(f"  ... and {len(values) - 10} more")
                result.append("")
        
        return [TextContent(type="text", text="\n".join(result))]

    async def get_schedule_by_day(self, day: str, venue: Optional[str] = None) -> List[TextContent]:
        """Get schedule for a specific day"""
        catalog = await self.fetch_catalog()
        
        # Filter by day
        day_sessions = [s for s in catalog if s.get("day", "").lower() == day.lower()]
        
        if venue:
            day_sessions = [s for s in day_sessions 
                          if venue.lower() in s.get("venue", {}).get("displayName", "").lower()]
        
        if not day_sessions:
            return [TextContent(type="text", text=f"No sessions found for {day}" + (f" at {venue}" if venue else ""))]
        
        # Sort by start time
        day_sessions.sort(key=lambda x: x.get("startTime", ""))
        
        result = [f"**Schedule for {day}**" + (f" at {venue}" if venue else "")]
        result.append(f"Found {len(day_sessions)} sessions\n")
        
        current_time = ""
        for session in day_sessions:
            session_time = session.get("startTime", "")
            if session_time != current_time:
                current_time = session_time
                result.append(f"## {session_time}")
            
            speakers = ", ".join([s.get("displayName", "") for s in session.get("speakers", [])])
            result.append(
                f"**{session.get('shortId', 'N/A')}** - {session.get('title', 'N/A')}\n"
                f"📍 {session.get('venueRoomName', 'N/A')}\n"
                f"👥 {speakers}\n"
                f"📊 Level {session.get('level', {}).get('value', 'N/A')}\n"
            )
        
        return [TextContent(type="text", text="\n".join(result))]

    async def get_rss_updates(self, limit: int = 10, category: Optional[str] = None) -> List[TextContent]:
        """Get latest RSS feed updates"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            query = "SELECT * FROM rss_items"
            params = []
            
            if category:
                query += " WHERE category LIKE ?"
                params.append(f"%{category}%")
            
            query += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)
            
            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            
            if not rows:
                return [TextContent(type="text", text="No RSS updates found. Try running sync_rss_feed first.")]
            
            result = [f"**Latest RSS Updates** ({len(rows)} items)\n"]
            
            for row in rows:
                result.append(
                    f"**{row[1]}**\n"  # title
                    f"📅 Published: {row[4]}\n"  # pub_date
                    f"🏷️ Category: {row[5]}\n"  # category
                    f"🔗 Link: {row[3]}\n"  # link
                    f"📝 {row[2][:300]}{'...' if len(row[2]) > 300 else ''}\n"  # description
                    f"---\n"
                )
            
            return [TextContent(type="text", text="\n".join(result))]

    async def sync_rss_feed(self) -> List[TextContent]:
        """Manually sync RSS feed"""
        try:
            result = await self.fetch_and_store_rss_feed()
            return [TextContent(type="text", text=
                f"✅ RSS Feed Sync Complete\n\n"
                f"📊 **Statistics:**\n"
                f"- Items processed: {result['items_processed']}\n"
                f"- New items: {result['items_new']}\n"
                f"- Feed title: {result['feed_title']}\n"
                f"- Last build: {result['last_build_date']}\n"
            )]
        except Exception as e:
            return [TextContent(type="text", text=f"❌ RSS sync failed: {str(e)}")]

    async def get_aws_events(self, day: Optional[str] = None, event_type: Optional[str] = None, limit: int = 50) -> List[TextContent]:
        """Get AWS official events"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            query = "SELECT * FROM aws_events WHERE 1=1"
            params = []
            
            if day:
                query += " AND date LIKE ?"
                params.append(f"%{day}%")
            
            if event_type:
                query += " AND event_type = ?"
                params.append(event_type)
            
            query += " ORDER BY date, time LIMIT ?"
            params.append(limit)
            
            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            
            if not rows:
                return [TextContent(type="text", text="No AWS events found. Try running sync_aws_events first.")]
            
            result = [f"**AWS Official Events** ({len(rows)} events)\n"]
            
            current_date = ""
            for row in rows:
                if row[1] != current_date:  # date
                    current_date = row[1]
                    result.append(f"\n## {current_date}")
                
                result.append(
                    f"**{row[2]} {row[3]}**\n"  # time, title
                    f"🏷️ Type: {row[7]}\n"  # event_type
                    f"📍 Location: {row[5]}\n"  # location
                    f"⏱️ Duration: {row[6]}\n"  # duration
                    f"📝 {row[4]}\n"  # description
                    f"---\n"
                )
            
            return [TextContent(type="text", text="\n".join(result))]

    async def sync_aws_events(self) -> List[TextContent]:
        """Manually sync AWS events"""
        try:
            result = await self.fetch_and_store_aws_events()
            return [TextContent(type="text", text=
                f"✅ AWS Events Sync Complete\n\n"
                f"📊 **Statistics:**\n"
                f"- Events processed: {result['items_processed']}\n"
                f"- New events: {result['items_new']}\n"
            )]
        except Exception as e:
            return [TextContent(type="text", text=f"❌ AWS events sync failed: {str(e)}")]

    async def sync_all_data(self) -> List[TextContent]:
        """Sync all data sources"""
        results = []
        
        # Sync RSS
        try:
            rss_result = await self.fetch_and_store_rss_feed()
            results.append(f"✅ RSS: {rss_result['items_new']} new items")
        except Exception as e:
            results.append(f"❌ RSS failed: {str(e)}")
        
        # Sync AWS Events
        try:
            events_result = await self.fetch_and_store_aws_events()
            results.append(f"✅ AWS Events: {events_result['items_new']} events")
        except Exception as e:
            results.append(f"❌ AWS Events failed: {str(e)}")
        

        # Sync Sessions
        try:
            await self.fetch_catalog(force_refresh=True)
            results.append("✅ Sessions: Updated")
        except Exception as e:
            results.append(f"❌ Sessions failed: {str(e)}")
        
        return [TextContent(type="text", text=
            f"🔄 **Complete Data Sync Results**\n\n" + "\n".join(results)
        )]

    async def get_sync_history(self, source: Optional[str] = None, limit: int = 20) -> List[TextContent]:
        """Get synchronization history"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            query = "SELECT * FROM sync_log"
            params = []
            
            if source:
                query += " WHERE source = ?"
                params.append(source)
            
            query += " ORDER BY sync_timestamp DESC LIMIT ?"
            params.append(limit)
            
            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            
            if not rows:
                return [TextContent(type="text", text="No sync history found.")]
            
            result = [f"**Synchronization History** ({len(rows)} records)\n"]
            
            for row in rows:
                status_icon = "✅" if row[6] == "success" else "❌"
                error_info = f"\n❌ Error: {row[7]}" if row[7] else ""
                
                result.append(
                    f"{status_icon} **{row[1]} - {row[2]}**\n"  # source, sync_type
                    f"📅 {row[8]}\n"  # sync_timestamp
                    f"📊 Processed: {row[3]}, New: {row[4]}, Updated: {row[5]}\n"  # stats
                    f"🔄 Status: {row[6]}{error_info}\n"  # status, error
                    f"---\n"
                )
            
            return [TextContent(type="text", text="\n".join(result))]

    async def add_personal_event(self, title: str, start_datetime: str, end_datetime: str,
                               description: Optional[str] = None, location: Optional[str] = None,
                               event_type: str = "personal", notes: Optional[str] = None) -> List[TextContent]:
        """Add a personal event"""
        await self.init_database()
        
        try:
            # Validate datetime format
            from datetime import datetime
            datetime.strptime(start_datetime, "%Y-%m-%d %H:%M")
            datetime.strptime(end_datetime, "%Y-%m-%d %H:%M")
        except ValueError:
            return [TextContent(type="text", text="❌ Invalid datetime format. Use YYYY-MM-DD HH:MM")]
        
        async with aiosqlite.connect(DB_PATH) as db:
            cursor = await db.execute("""
                INSERT INTO personal_events (title, description, start_datetime, end_datetime, location, event_type, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (title, description, start_datetime, end_datetime, location, event_type, notes))
            
            event_id = cursor.lastrowid
            await db.commit()
            
            return [TextContent(type="text", text=
                f"✅ **Événement personnel ajouté**\n\n"
                f"📅 **{title}**\n"
                f"🕐 {start_datetime} - {end_datetime}\n"
                f"📍 {location or 'Lieu non spécifié'}\n"
                f"🏷️ Type: {event_type}\n"
                f"📝 {description or 'Pas de description'}\n"
                f"🆔 ID: {event_id}"
            )]

    async def get_personal_events(self, day: Optional[str] = None, event_type: Optional[str] = None) -> List[TextContent]:
        """Get personal events"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            query = "SELECT * FROM personal_events WHERE 1=1"
            params = []
            
            if day:
                # Convert day name to date pattern
                day_patterns = {
                    'monday': '2025-12-01',
                    'tuesday': '2025-12-02', 
                    'wednesday': '2025-12-03',
                    'thursday': '2025-12-04',
                    'friday': '2025-12-05'
                }
                date_pattern = day_patterns.get(day.lower())
                if date_pattern:
                    query += " AND start_datetime LIKE ?"
                    params.append(f"{date_pattern}%")
            
            if event_type:
                query += " AND event_type = ?"
                params.append(event_type)
            
            query += " ORDER BY start_datetime"
            
            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            
            if not rows:
                return [TextContent(type="text", text="Aucun événement personnel trouvé.")]
            
            result = [f"**Événements personnels** ({len(rows)} événements)\n"]
            
            for row in rows:
                result.append(
                    f"**{row[1]}** (ID: {row[0]})\n"  # title, id
                    f"🕐 {row[3]} - {row[4]}\n"  # start_datetime, end_datetime
                    f"📍 {row[5] or 'Lieu non spécifié'}\n"  # location
                    f"🏷️ Type: {row[6]}\n"  # event_type
                    f"📝 {row[2] or 'Pas de description'}\n"  # description
                    f"📋 Notes: {row[7] or 'Aucune'}\n"  # notes
                    f"---\n"
                )
            
            return [TextContent(type="text", text="\n".join(result))]

    async def delete_personal_event(self, event_id: int) -> List[TextContent]:
        """Delete a personal event"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            # Check if event exists
            cursor = await db.execute("SELECT title FROM personal_events WHERE id = ?", (event_id,))
            event = await cursor.fetchone()
            
            if not event:
                return [TextContent(type="text", text=f"❌ Événement avec ID {event_id} non trouvé.")]
            
            # Delete event
            await db.execute("DELETE FROM personal_events WHERE id = ?", (event_id,))
            await db.commit()
            
            return [TextContent(type="text", text=f"✅ Événement '{event[0]}' supprimé avec succès.")]

    async def add_session_to_favorites(self, session_id: str, list_name: str, 
                                     notes: Optional[str] = None, priority: int = 1) -> List[TextContent]:
        """Add a session to favorites"""
        await self.init_database()
        
        # Find session details
        catalog = await self.fetch_catalog()
        session = None
        for s in catalog:
            if s.get("id") == session_id or s.get("shortId") == session_id:
                session = s
                break
        
        if not session:
            return [TextContent(type="text", text=f"❌ Session '{session_id}' non trouvée.")]
        
        async with aiosqlite.connect(DB_PATH) as db:
            try:
                await db.execute("""
                    INSERT INTO favorite_sessions (list_name, session_id, session_short_id, session_title, notes, priority)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (list_name, session.get("id"), session.get("shortId"), session.get("title"), notes, priority))
                
                await db.commit()
                
                return [TextContent(type="text", text=
                    f"✅ **Session ajoutée aux favoris**\n\n"
                    f"📋 Liste: {list_name}\n"
                    f"🎯 Session: {session.get('shortId')} - {session.get('title')}\n"
                    f"⭐ Priorité: {priority}\n"
                    f"📝 Notes: {notes or 'Aucune'}"
                )]
                
            except Exception as e:
                if "UNIQUE constraint failed" in str(e):
                    return [TextContent(type="text", text=f"❌ Session déjà présente dans la liste '{list_name}'.")]
                else:
                    return [TextContent(type="text", text=f"❌ Erreur: {str(e)}")]

    async def get_favorite_sessions(self, list_name: str = "all") -> List[TextContent]:
        """Get favorite sessions"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            if list_name == "all":
                query = """
                    SELECT fs.*, s.start_datetime, s.end_datetime, s.day, s.venue, s.room, s.level
                    FROM favorite_sessions fs
                    LEFT JOIN sessions s ON fs.session_id = s.id
                    ORDER BY fs.list_name, fs.priority, s.start_datetime
                """
                params = []
            else:
                query = """
                    SELECT fs.*, s.start_datetime, s.end_datetime, s.day, s.venue, s.room, s.level
                    FROM favorite_sessions fs
                    LEFT JOIN sessions s ON fs.session_id = s.id
                    WHERE fs.list_name = ?
                    ORDER BY fs.priority, s.start_datetime
                """
                params = [list_name]
            
            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            
            if not rows:
                filter_text = f" dans '{list_name}'" if list_name != "all" else ""
                return [TextContent(type="text", text=f"Aucune session favorite trouvée{filter_text}.")]
            
            result = []
            if list_name == "all":
                result.append(f"**Toutes les sessions favorites** ({len(rows)} sessions)\n")
            else:
                result.append(f"**Sessions favorites - {list_name}** ({len(rows)} sessions)\n")
            
            current_list = ""
            for row in rows:
                if list_name == "all" and row[1] != current_list:  # list_name
                    current_list = row[1]
                    result.append(f"\n## 📋 {current_list.upper()}")
                
                # Row structure: fs.id, fs.list_name, fs.session_id, fs.session_short_id, fs.session_title, fs.notes, fs.priority, fs.created_at, s.start_datetime, s.end_datetime, s.day, s.venue, s.room, s.level
                priority = int(row[6]) if row[6] else 1  # fs.priority
                priority_stars = "⭐" * priority
                level_info = f"Level {row[13]}" if row[13] else "N/A"  # s.level
                
                result.append(
                    f"**{row[3]}** - {row[4]}\n"  # fs.session_short_id, fs.session_title
                    f"{priority_stars} Priorité {priority}\n"
                    f"📅 {row[10]} à {row[8][11:16] if row[8] and len(row[8]) > 16 else 'N/A'}-{row[9][11:16] if row[9] and len(row[9]) > 16 else 'N/A'}\n"  # s.day, s.start_datetime, s.end_datetime
                    f"📍 {row[11]} - {row[12] or 'N/A'}\n"  # s.venue, s.room
                    f"📊 {level_info}\n"
                    f"📝 Notes: {row[5] or 'Aucune'}\n"  # fs.notes
                    f"---\n"
                )
            
            return [TextContent(type="text", text="\n".join(result))]

    async def remove_session_from_favorites(self, session_id: str, list_name: str) -> List[TextContent]:
        """Remove session from favorites"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            # Check if session exists in list
            cursor = await db.execute("""
                SELECT session_title FROM favorite_sessions 
                WHERE (session_id = ? OR session_short_id = ?) AND list_name = ?
            """, (session_id, session_id, list_name))
            
            session = await cursor.fetchone()
            if not session:
                return [TextContent(type="text", text=f"❌ Session '{session_id}' non trouvée dans '{list_name}'.")]
            
            # Remove session
            await db.execute("""
                DELETE FROM favorite_sessions 
                WHERE (session_id = ? OR session_short_id = ?) AND list_name = ?
            """, (session_id, session_id, list_name))
            
            await db.commit()
            
            return [TextContent(type="text", text=f"✅ Session '{session[0]}' supprimée de '{list_name}'.")]

    async def create_favorite_list(self, list_name: str, description: Optional[str] = None) -> List[TextContent]:
        """Create a custom favorite list"""
        await self.init_database()
        
        async with aiosqlite.connect(DB_PATH) as db:
            try:
                await db.execute("""
                    INSERT INTO favorite_lists (list_name, description) VALUES (?, ?)
                """, (list_name, description))
                
                await db.commit()
                
                return [TextContent(type="text", text=
                    f"✅ **Liste de favoris créée**\n\n"
                    f"📋 Nom: {list_name}\n"
                    f"📝 Description: {description or 'Aucune'}"
                )]
                
            except Exception as e:
                if "UNIQUE constraint failed" in str(e):
                    return [TextContent(type="text", text=f"❌ Liste '{list_name}' existe déjà.")]
                else:
                    return [TextContent(type="text", text=f"❌ Erreur: {str(e)}")]

    async def export_schedule_to_ical(self, list_name: str = "all", include_personal_events: bool = True, 
                                    filename: str = "reinvent_schedule") -> List[TextContent]:
        """Export schedule to iCal format"""
        await self.init_database()
        
        try:
            cal = Calendar()
            cal.add('prodid', '-//re:Invent Planner MCP Server//mxm.dk//')
            cal.add('version', '2.0')
            cal.add('calscale', 'GREGORIAN')
            cal.add('method', 'PUBLISH')
            cal.add('x-wr-calname', f'AWS re:Invent 2025 - {list_name}')
            cal.add('x-wr-caldesc', 'Planning AWS re:Invent 2025 généré par MCP Server')
            
            events_added = 0
            
            async with aiosqlite.connect(DB_PATH) as db:
                # Add favorite sessions
                if list_name == "all":
                    query = """
                        SELECT fs.*, s.start_datetime, s.end_datetime, s.abstract, s.venue, s.room, s.speakers
                        FROM favorite_sessions fs
                        LEFT JOIN sessions s ON fs.session_id = s.id
                        WHERE s.start_datetime IS NOT NULL
                        ORDER BY s.start_datetime
                    """
                    params = []
                else:
                    query = """
                        SELECT fs.*, s.start_datetime, s.end_datetime, s.abstract, s.venue, s.room, s.speakers
                        FROM favorite_sessions fs
                        LEFT JOIN sessions s ON fs.session_id = s.id
                        WHERE fs.list_name = ? AND s.start_datetime IS NOT NULL
                        ORDER BY s.start_datetime
                    """
                    params = [list_name]
                
                cursor = await db.execute(query, params)
                sessions = await cursor.fetchall()
                
                for session in sessions:
                    try:
                        event = iCalEvent()
                        event.add('uid', f"session-{session[2]}@reinvent-planner")  # session_id
                        event.add('summary', f"{session[3]} - {session[4]}")  # short_id, title
                        
                        # Parse datetime
                        start_dt = datetime.fromisoformat(session[7].replace('Z', '+00:00'))
                        end_dt = datetime.fromisoformat(session[8].replace('Z', '+00:00'))
                        
                        event.add('dtstart', start_dt)
                        event.add('dtend', end_dt)
                        
                        # Location
                        location = f"{session[10]} - {session[11]}" if session[10] and session[11] else session[10] or session[11] or "TBD"
                        event.add('location', location)
                        
                        # Description
                        description_parts = []
                        if session[9]:  # abstract
                            description_parts.append(f"Résumé: {session[9]}")
                        if session[6]:  # notes
                            description_parts.append(f"Notes personnelles: {session[6]}")
                        if session[12]:  # speakers
                            try:
                                speakers_data = json.loads(session[12])
                                if speakers_data:
                                    description_parts.append(f"Speakers: {', '.join(speakers_data)}")
                            except (json.JSONDecodeError, TypeError):
                                pass  # Skip if speakers data is not valid JSON
                        
                        event.add('description', '\n\n'.join(description_parts))
                        
                        # Categories
                        event.add('categories', [f"re:Invent", f"Plan-{session[1]}", f"Priority-{session[5]}"])
                        
                        cal.add_component(event)
                        events_added += 1
                        
                    except Exception as e:
                        logger.error(f"Error adding session {session[3]} to calendar: {e}")
                
                # Add personal events
                if include_personal_events:
                    cursor = await db.execute("SELECT * FROM personal_events ORDER BY start_datetime")
                    personal_events = await cursor.fetchall()
                    
                    for pe in personal_events:
                        try:
                            event = iCalEvent()
                            event.add('uid', f"personal-{pe[0]}@reinvent-planner")  # id
                            event.add('summary', pe[1])  # title
                            
                            # Parse datetime
                            start_dt = datetime.strptime(pe[3], "%Y-%m-%d %H:%M")
                            end_dt = datetime.strptime(pe[4], "%Y-%m-%d %H:%M")
                            
                            event.add('dtstart', start_dt)
                            event.add('dtend', end_dt)
                            
                            if pe[5]:  # location
                                event.add('location', pe[5])
                            
                            # Description
                            description_parts = []
                            if pe[2]:  # description
                                description_parts.append(pe[2])
                            if pe[7]:  # notes
                                description_parts.append(f"Notes: {pe[7]}")
                            
                            if description_parts:
                                event.add('description', '\n\n'.join(description_parts))
                            
                            # Categories
                            event.add('categories', [f"re:Invent", f"Personal", pe[6]])  # event_type
                            
                            cal.add_component(event)
                            events_added += 1
                            
                        except Exception as e:
                            logger.error(f"Error adding personal event {pe[1]} to calendar: {e}")
            
            # Save to file
            ical_filename = f"{filename}.ics"
            with open(ical_filename, 'wb') as f:
                f.write(cal.to_ical())
            
            return [TextContent(type="text", text=
                f"✅ **Export iCal terminé**\n\n"
                f"📅 Fichier: {ical_filename}\n"
                f"📊 Événements exportés: {events_added}\n"
                f"📋 Liste: {list_name}\n"
                f"👤 Événements personnels: {'Inclus' if include_personal_events else 'Exclus'}\n\n"
                f"💡 **Utilisation:**\n"
                f"1. Ouvrez Outlook\n"
                f"2. Fichier > Importer/Exporter\n"
                f"3. Sélectionnez le fichier {ical_filename}\n"
                f"4. Vos sessions re:Invent apparaîtront dans votre calendrier !"
            )]
            
        except Exception as e:
            return [TextContent(type="text", text=f"❌ Erreur lors de l'export: {str(e)}")]

async def main():
    server_instance = ReinventPlannerServer()
    
    async with stdio_server() as (read_stream, write_stream):
        await server_instance.server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="reinvent-planner",
                server_version="3.0.0",
                capabilities=ServerCapabilities(
                    resources={"subscribe": False, "listChanged": False},
                    tools={"listChanged": False},
                    prompts={"listChanged": False},
                    logging={}
                )
            )
        )

if __name__ == "__main__":
    asyncio.run(main())