import unittest

import locustfile


class FakeResponse:
    def __init__(self, result, *, status_code=200, error=None):
        self._result = result
        self.status_code = status_code
        self.error = error
        self.failure_message = None
        self.was_successful = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def json(self):
        return self._result

    def failure(self, message):
        self.failure_message = message

    def success(self):
        self.was_successful = True


class FakeClient:
    def __init__(self, served_by):
        self.served_by = served_by
        self.calls = []
        self.responses = []

    def post(self, path, **kwargs):
        self.calls.append((path, kwargs))
        response = FakeResponse(
            {
                "matchId": kwargs["json"]["matchId"],
                "servedBy": self.served_by,
                "durationMs": 10,
                "outcome": "win",
                "protocolHash": "abc123",
            }
        )
        self.responses.append(response)
        return response


def battle_user(client):
    user = object.__new__(locustfile.BattleUser)
    user.client = client
    return user


class BattleUserTests(unittest.TestCase):
    def setUp(self):
        locustfile.reset_served_by_counts(None)

    def test_battle_request_closes_connection(self):
        client = FakeClient("simulator-1")

        battle_user(client).simulate_battle()

        self.assertEqual(client.calls[0][1]["headers"], {"Connection": "close"})

    def test_test_start_resets_served_by_counts(self):
        locustfile._served_by_counts.update({"simulator-1": 3})

        locustfile.reset_served_by_counts(None)

        self.assertEqual(locustfile._served_by_counts, {})

    def test_successful_responses_are_counted_by_served_by(self):
        first_client = FakeClient("simulator-2")
        second_client = FakeClient("simulator-1")

        battle_user(first_client).simulate_battle()
        battle_user(first_client).simulate_battle()
        battle_user(second_client).simulate_battle()

        self.assertEqual(
            locustfile._served_by_counts,
            {"simulator-1": 1, "simulator-2": 2},
        )
        self.assertTrue(first_client.responses[0].was_successful)

    def test_malformed_served_by_fails_and_is_not_counted(self):
        for malformed_value in (None, 123, "", "   "):
            with self.subTest(served_by=malformed_value):
                locustfile.reset_served_by_counts(None)
                client = FakeClient(malformed_value)

                battle_user(client).simulate_battle()

                self.assertEqual(
                    client.responses[0].failure_message,
                    "HTTP 200 response field servedBy was not a non-empty string",
                )
                self.assertFalse(client.responses[0].was_successful)
                self.assertEqual(locustfile._served_by_counts, {})

    def test_distribution_summary_is_sorted(self):
        locustfile._served_by_counts.update(
            {"simulator-z": 1, "simulator-a": 2}
        )

        with self.assertLogs(level="INFO") as captured:
            locustfile.print_served_by_distribution(None)

        self.assertEqual(
            captured.output[-1],
            "INFO:root:servedBy distribution: simulator-a=2, simulator-z=1",
        )


if __name__ == "__main__":
    unittest.main()
