"""Locust workload for sustained simulator battle traffic.

Set ``LOCUST_HOST`` (or pass ``--host``) to select the simulator endpoint and
``LOCUST_RUN_TIME`` (or pass ``--run-time``) to bound an experiment phase.
Set ``BATTLE_REQUEST_TIMEOUT_SECONDS`` to override the 30-second HTTP timeout.
User count and spawn rate remain Locust settings so the same workload can be
used for the low-, moderate-, and high-concurrency phases.
"""

from itertools import count
import logging
import os
import socket
from uuid import uuid4

from locust import HttpUser, constant, task

SPECIES_PAIRS = (
    ("Blissey", "Shuckle"),
    ("Umbreon", "Toxapex"),
    ("Cresselia", "Dondozo"),
    ("Lugia", "Giratina"),
    ("Dragonite", "Goodra"),
)

REQUIRED_RESPONSE_FIELDS = (
    "matchId",
    "servedBy",
    "durationMs",
    "outcome",
    "protocolHash",
)

BATTLE_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("BATTLE_REQUEST_TIMEOUT_SECONDS", "30")
)

_request_numbers = count(1)
_observed_servers: set[str] = set()
_match_id_prefix = "-".join(
    (
        os.getenv("LOAD_TEST_RUN_ID") or uuid4().hex,
        socket.gethostname(),
        str(os.getpid()),
    )
)


def seed_from_counter(request_number: int) -> list[int]:
    """Derive four reproducible Showdown seed words from a request number."""

    return [
        (request_number * multiplier + offset) & 0xFFFF
        for multiplier, offset in (
            (17, 11),
            (31, 23),
            (43, 37),
            (59, 53),
        )
    ]


class BattleUser(HttpUser):
    # Each user immediately starts its next battle after the previous response.
    # Experiment intensity is therefore controlled directly by Locust users.
    wait_time = constant(0)

    @task
    def simulate_battle(self) -> None:
        request_number = next(_request_numbers)
        pokemon1, pokemon2 = SPECIES_PAIRS[
            (request_number - 1) % len(SPECIES_PAIRS)
        ]
        match_id = f"{_match_id_prefix}-{request_number}"
        payload = {
            "matchId": match_id,
            "pokemon1": pokemon1,
            "pokemon2": pokemon2,
            "seed": seed_from_counter(request_number),
            "maxTurns": 100,
        }

        with self.client.post(
            "/v1/battles",
            json=payload,
            name="/v1/battles",
            catch_response=True,
            timeout=BATTLE_REQUEST_TIMEOUT_SECONDS,
        ) as response:
            if response.status_code != 200:
                response.failure(f"expected HTTP 200, got {response.status_code}")
                return

            try:
                result = response.json()
            except ValueError:
                response.failure("HTTP 200 response was not valid JSON")
                return

            if not isinstance(result, dict):
                response.failure("HTTP 200 response was not a JSON object")
                return

            missing_fields = [
                field
                for field in REQUIRED_RESPONSE_FIELDS
                if field not in result
            ]
            if missing_fields:
                response.failure(
                    "HTTP 200 response omitted required fields: "
                    + ", ".join(missing_fields)
                )
                return

            if result["matchId"] != match_id:
                response.failure(
                    "HTTP 200 response matchId did not match the request: "
                    f"expected {match_id!r}, got {result['matchId']!r}"
                )
                return

            served_by = result["servedBy"]
            if not isinstance(served_by, str) or not served_by:
                response.failure(
                    "HTTP 200 response field servedBy was not a non-empty string"
                )
                return

            if served_by not in _observed_servers:
                _observed_servers.add(served_by)
                logging.info("Observed simulator servedBy=%s", served_by)
