ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Build context contains only verified SQL, metadata and these startup scripts.
COPY payload/ /opt/localization/
COPY localization-entrypoint.sh /usr/local/bin/localization-entrypoint.sh
COPY localization-healthcheck.sh /usr/local/bin/localization-healthcheck.sh
COPY 10-localization.sh /docker-entrypoint-initdb.d/10-localization.sh
RUN chmod 0755 /usr/local/bin/localization-entrypoint.sh /usr/local/bin/localization-healthcheck.sh /docker-entrypoint-initdb.d/10-localization.sh \
    && cd /opt/localization && sha256sum -c SHA256SUMS

ENV POSTGRES_DB=localization_staging
HEALTHCHECK --interval=15s --timeout=10s --start-period=30m --retries=3 CMD ["/usr/local/bin/localization-healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/localization-entrypoint.sh"]
CMD ["postgres"]
