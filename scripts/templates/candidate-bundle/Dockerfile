ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/postgres-upstream-entrypoint.sh
COPY postgres-init-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY payload/ /opt/localization/
COPY localization-entrypoint.sh /usr/local/bin/localization-entrypoint.sh
COPY healthcheck.sh /usr/local/bin/localization-healthcheck.sh
COPY initialize.sh /docker-entrypoint-initdb.d/10-localization.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/localization-entrypoint.sh /usr/local/bin/localization-healthcheck.sh /docker-entrypoint-initdb.d/10-localization.sh \
    && cd /opt/localization && sha256sum -c SHA256SUMS
ENV POSTGRES_DB=localization_staging
HEALTHCHECK --interval=15s --timeout=10s --start-period=45m --retries=3 CMD ["/usr/local/bin/localization-healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/localization-entrypoint.sh"]
CMD ["postgres"]
