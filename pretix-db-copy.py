# Run through "python3 -m pretix shell -c 'exec(open(...).read())'" by
# docker-entrypoint-plugins.sh to copy the old SQLite data into Postgres.
# pretix wraps most models in django-scopes, which plain dumpdata/loaddata
# refuse to touch, so both run with scopes disabled.
#   PRETIX_COPY_MODE = dump | load
#   PRETIX_COPY_FILE = path of the JSON fixture
import os

from django.core.management import call_command
from django_scopes import scopes_disabled

mode = os.environ["PRETIX_COPY_MODE"]
path = os.environ["PRETIX_COPY_FILE"]

with scopes_disabled():
    if mode == "dump":
        call_command(
            "dumpdata",
            natural_foreign=True,
            natural_primary=True,
            exclude=["contenttypes", "auth.permission", "sessions"],
            format="json",
            output=path,
        )
    else:
        call_command("loaddata", path, format="json")
